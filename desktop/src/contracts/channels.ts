/** Whitelisted IPC channel names. Renderer never sees ipcRenderer directly. */

export const CHANNELS = {
  startQuery: "archive:startQuery",
  cancelQuery: "archive:cancelQuery",
  getView: "archive:getView",
  exportResults: "archive:exportResults",
  copySelection: "archive:copySelection",
  jobEvent: "archive:jobEvent",
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];
