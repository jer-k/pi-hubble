export interface HubbleVault {
  root: string;
}

export interface HubblePath {
  absolute: string;
  relative: string;
}

export interface HubbleEdit {
  oldText: string;
  newText: string;
}

export interface TruncatedOutput {
  text: string;
  truncated: boolean;
  fullOutputPath?: string;
}
