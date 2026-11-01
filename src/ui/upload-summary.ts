import type { EmergencyUploadReport } from "../main";
import { plural } from "../core/plural";

/** One plain sentence (plus failures) describing what an emergency upload did. */
export function describeEmergencyUpload(report: EmergencyUploadReport): string {
  const parts: string[] = [];
  if (report.uploaded > 0) parts.push(`${plural(report.uploaded, "new file")} uploaded`);
  if (report.replaced > 0) parts.push(`${plural(report.replaced, "file")} replaced on Nextcloud with this device's version`);
  if (report.alreadyThere > 0) parts.push(`${plural(report.alreadyThere, "file")} already identical`);
  if (report.leftForSync > 0) parts.push(`${plural(report.leftForSync, "file")} left to the normal sync because Nextcloud holds a newer version`);
  if (parts.length === 0) parts.push("Nothing needed uploading");
  let text = `${parts.join(" · ")}.`;
  if (report.failed > 0) text += ` ${plural(report.failed, "file")} could not be uploaded: ${report.failures.slice(0, 3).join("; ")}${report.failed > 3 ? "…" : ""}`;
  return text;
}
