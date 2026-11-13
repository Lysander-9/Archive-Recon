/** Whitelisted IPC channel names. Renderer never sees ipcRenderer directly. */

export const CHANNELS = {
  startQuery: "archive:startQuery",
  cancelQuery: "archive:cancelQuery",
  getView: "archive:getView",
  exportResults: "archive:exportResults",
  copySelection: "archive:copySelection",
  copyReasons: "archive:copyReasons",
  themeGet: "archive:themeGet",
  themeChanged: "archive:themeChanged",
  jobEvent: "archive:jobEvent",
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];
