import type { HttpRequest, HttpResponse, HttpTransport } from "../../src/network/http-client";

interface FakeFile { bytes: Uint8Array; fileId: string; etag: string; mtime: string; }

/** Small in-memory DAV server covering the Stage-7 protocol surface. */
export class FakeNextcloudDav implements HttpTransport {
  private readonly files = new Map<string, FakeFile>();
  private readonly collections = new Set<string>();
  private id = 100;
  private etag = 1000;
  failChunkName: string | null = null;
  reuseEtagOnNextUpdate = false;
  /** Real Nextcloud behavior: the file ETag only changes when the stored mtime changes. */
  etagFollowsMtime = false;
  rangeGets = 0;
  chunkPuts = 0;

  constructor(public readonly serverUrl: string, public readonly userId: string) {
    this.addCollection(`${serverUrl}/remote.php/dav/`);
    this.addCollection(`${serverUrl}/remote.php/dav/files/`);
    this.addCollection(`${serverUrl}/remote.php/dav/files/${encodeURIComponent(userId)}/`);
    this.addCollection(`${serverUrl}/remote.php/dav/files/${encodeURIComponent(userId)}/Obsidian/`);
    this.addCollection(`${serverUrl}/remote.php/dav/uploads/`);
    this.addCollection(`${serverUrl}/remote.php/dav/uploads/${encodeURIComponent(userId)}/`);
  }

  async request(request: HttpRequest): Promise<HttpResponse> {
    const method = request.method ?? "GET";
    const url = canonical(request.url, method === "MKCOL" || request.url.endsWith("/"));
    switch (method) {
      case "PROPFIND": return this.propfind(url, request);
      case "MKCOL": return this.mkcol(url);
      case "PUT": return this.put(url, request);
      case "MOVE": return this.move(url, request);
      case "DELETE": return this.remove(url, request);
      case "GET": return this.get(url, request);
      default: return response(405);
    }
  }

  getFile(url: string): ArrayBuffer | null { const f=this.files.get(canonical(url,false)); return f ? copy(f.bytes) : null; }
  fileUrls(): string[] { return [...this.files.keys()]; }

  private propfind(url: string, request: HttpRequest): HttpResponse {
    const file = this.files.get(canonical(url,false));
    if (file) return xmlResponse([fileXml(canonical(url,false), file)]);
    const collectionUrl = canonical(url,true);
    if (!this.collections.has(collectionUrl)) return response(404);
    const rows = [collectionXml(collectionUrl)];
    if ((request.headers?.Depth ?? request.headers?.depth) === "1") {
      for (const child of [...this.collections].filter((value) => value !== collectionUrl && parentUrl(value) === collectionUrl).sort()) rows.push(collectionXml(child));
      for (const [child, value] of [...this.files].filter(([value]) => parentUrl(value) === collectionUrl).sort(([a],[b])=>a.localeCompare(b))) rows.push(fileXml(child, value));
    }
    return xmlResponse(rows);
  }

  private mkcol(url: string): HttpResponse {
    const collectionUrl=canonical(url,true);
    if(this.collections.has(collectionUrl)) return response(405);
    const parent=parentUrl(collectionUrl);
    if(parent && !this.collections.has(parent)) return response(409);
    this.collections.add(collectionUrl); return response(201);
  }

  private put(url: string, request: HttpRequest): HttpResponse {
    const key=canonical(url,false); const name=decodeURIComponent(new URL(key).pathname.split('/').pop() ?? "");
    if(this.failChunkName && name===this.failChunkName) throw new Error(`Injected chunk transport failure: ${name}`);
    if(request.headers?.["If-None-Match"] === "*" && this.files.has(key)) return response(412);
    const parent=parentUrl(key); if(parent && !this.collections.has(parent)) return response(409);
    const existing=this.files.get(key);
    const match=request.headers?.["If-Match"];
    if(match && (!existing || existing.etag!==match)) return response(412);
    const body=typeof request.body === "string" ? new TextEncoder().encode(request.body) : new Uint8Array(request.body ?? new ArrayBuffer(0));
    const sourceMtime=request.headers?.["X-OC-MTime"];
    const mtime=(sourceMtime && /^[0-9]+$/.test(sourceMtime) ? new Date(Number(sourceMtime)*1000) : new Date()).toUTCString();
    const sameStoredMtime=!!existing && existing.mtime===mtime;
    const etag = existing && (this.reuseEtagOnNextUpdate || (this.etagFollowsMtime && sameStoredMtime)) ? existing.etag : this.nextEtag();
    if (existing) this.reuseEtagOnNextUpdate = false;
    this.files.set(key,{bytes:new Uint8Array(body),fileId:existing?.fileId ?? String(this.id++),etag,mtime});
    if(/^\d{5}$/.test(name)) this.chunkPuts += 1;
    return response(existing ? 204 : 201);
  }

  private move(url: string, request: HttpRequest): HttpResponse {
    const destinationRaw=request.headers?.Destination; if(!destinationRaw) return response(400);
    const destination=canonical(destinationRaw,false);
    if(request.headers?.Overwrite === "F" && this.files.has(destination)) return response(412);
    if(url.endsWith('/.file')) {
      const uploadRoot=url.slice(0,-'.file'.length);
      const chunks=[...this.files.entries()]
        .filter(([key])=>parentUrl(key)===uploadRoot && /^\d{5}$/.test(decodeURIComponent(new URL(key).pathname.split('/').pop() ?? "")))
        .sort(([a],[b])=>a.localeCompare(b));
      if(chunks.length===0) return response(404);
      const total=chunks.reduce((sum,[,file])=>sum+file.bytes.byteLength,0); const bytes=new Uint8Array(total); let offset=0;
      for(const [,file] of chunks){bytes.set(file.bytes,offset);offset+=file.bytes.byteLength;}
      const parent=parentUrl(destination); if(parent && !this.collections.has(parent)) return response(409);
      this.files.set(destination,{bytes,fileId:String(this.id++),etag:this.nextEtag(),mtime:new Date().toUTCString()});
      // Nextcloud consumes the upload collection on assembly.
      this.deleteCollection(uploadRoot);
      return response(201);
    }
    const source=canonical(url,false); const file=this.files.get(source); if(!file) return response(404);
    const ifMatch=request.headers?.["If-Match"]; if(ifMatch && file.etag!==ifMatch) return response(412);
    const parent=parentUrl(destination); if(parent && !this.collections.has(parent)) return response(409);
    this.files.set(destination,{...file,etag:this.nextEtag(),mtime:new Date().toUTCString()}); this.files.delete(source);
    return response(201);
  }

  private remove(url: string, request: HttpRequest): HttpResponse {
    const key=canonical(url,false); const file=this.files.get(key);
    if(file){const match=request.headers?.["If-Match"];if(match&&file.etag!==match)return response(412);this.files.delete(key);return response(204);}
    const collection=canonical(url,true); if(this.collections.has(collection)){this.deleteCollection(collection);return response(204);}
    return response(404);
  }

  private get(url: string, request: HttpRequest): HttpResponse {
    const key=canonical(url,false); const file=this.files.get(key); if(!file)return response(404);
    const match=request.headers?.["If-Match"]; if(match&&file.etag!==match)return response(412);
    const range=request.headers?.Range;
    if(range){const m=/^bytes=(\d+)-(\d+)$/.exec(range);if(!m)return response(416);const start=Number(m[1]),end=Number(m[2]);if(start<0||end<start||end>=file.bytes.byteLength)return response(416);this.rangeGets+=1;return response(206,{"Content-Range":`bytes ${start}-${end}/${file.bytes.byteLength}`,ETag:file.etag},copy(file.bytes.subarray(start,end+1)));}
    return response(200,{ETag:file.etag},copy(file.bytes));
  }

  private addCollection(url:string):void{this.collections.add(canonical(url,true));}
  private deleteCollection(url:string):void{const root=canonical(url,true);for(const key of [...this.files.keys()])if(key.startsWith(root))this.files.delete(key);for(const key of [...this.collections])if(key===root||key.startsWith(root))this.collections.delete(key);}
  private nextEtag():string{return `"fake-${this.etag++}"`;}
}

function response(status:number,headers:Record<string,string>={},body:ArrayBuffer=new ArrayBuffer(0)):HttpResponse{
  const text=new TextDecoder().decode(body);return{status,headers,text,arrayBuffer:body,json:()=>JSON.parse(text)};
}
function xmlResponse(rows:string[]):HttpResponse{const text=`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">${rows.join('')}</d:multistatus>`;const body=new TextEncoder().encode(text).buffer;return{status:207,headers:{"Content-Type":"application/xml"},text,arrayBuffer:body,json:()=>{throw new Error('not json');}};}
function collectionXml(url:string):string{return `<d:response><d:href>${esc(url)}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;}
function fileXml(url:string,file:FakeFile):string{return `<d:response><d:href>${esc(url)}</d:href><d:propstat><d:prop><d:getetag>${esc(file.etag)}</d:getetag><d:getcontentlength>${file.bytes.byteLength}</d:getcontentlength><d:getlastmodified>${esc(file.mtime)}</d:getlastmodified><d:resourcetype/><oc:fileid>${esc(file.fileId)}</oc:fileid><oc:size>${file.bytes.byteLength}</oc:size></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;}
function esc(value:string):string{return value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');}
function canonical(value:string,collection:boolean):string{const u=new URL(value);u.hash='';u.search='';const out=u.toString();return collection?(out.endsWith('/')?out:`${out}/`):out.replace(/\/$/,'');}
function parentUrl(value:string):string{const u=new URL(value);const path=u.pathname.replace(/\/$/,'');const slash=path.lastIndexOf('/');u.pathname=`${path.slice(0,slash+1)}`;u.search='';u.hash='';return u.toString();}
function copy(data:Uint8Array):ArrayBuffer{const out=new Uint8Array(data.byteLength);out.set(data);return out.buffer;}
