const MIB = 1024 * 1024;

/** Public Obsidian/platform limits used by composition code before whole-file reads begin. */
export interface PlatformCapabilities {
  isMobile: boolean;
  maxSafeWholeReadBytes: number;
  maxInFlightWholeReadBytes: number;
  localReadConcurrency: number;
  supportsWholeBufferOnly: true;
  guaranteesBackgroundExecution: false;
}

export function platformCapabilities(isMobile: boolean): PlatformCapabilities {
  return isMobile
    ? {
        isMobile: true,
        maxSafeWholeReadBytes: 32 * MIB,
        maxInFlightWholeReadBytes: 32 * MIB,
        localReadConcurrency: 1,
        supportsWholeBufferOnly: true,
        guaranteesBackgroundExecution: false
      }
    : {
        isMobile: false,
        maxSafeWholeReadBytes: 128 * MIB,
        maxInFlightWholeReadBytes: 64 * MIB,
        localReadConcurrency: 4,
        supportsWholeBufferOnly: true,
        guaranteesBackgroundExecution: false
      };
}
