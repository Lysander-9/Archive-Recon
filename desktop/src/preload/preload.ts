/** Minimal preload bridge: only whitelisted IPC methods, never ipcRenderer itself. */

import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS } from "../contracts/channels";
import type {
  CancelQueryRequest,
  CopyOutcome,
  CopyRequest,
  ExportOutcome,
  ExportRequest,
  GetViewRequest,
  JobEventDto,
  JobView,
  Result,
  StartQueryRequest,
} from "../contracts/types";

export interface ArchiveReconBridge {
  startQuery(request: StartQueryRequest): Promise<Result<{ jobId: number; source: string; scope: unknown }>>;
  cancelQuery(request: CancelQueryRequest): Promise<Result<{ status: string }>>;
  getView(request: GetViewRequest): Promise<Result<JobView>>;
  exportResults(request: ExportRequest): Promise<Result<ExportOutcome>>;
  copySelection(request: CopyRequest): Promise<Result<CopyOutcome>>;
  onJobEvent(listener: (event: JobEventDto) => void): () => void;
}

const bridge: ArchiveReconBridge = {
  startQuery: (request) => ipcRenderer.invoke(CHANNELS.startQuery, request),
  cancelQuery: (request) => ipcRenderer.invoke(CHANNELS.cancelQuery, request),
  getView: (request) => ipcRenderer.invoke(CHANNELS.getView, request),
  exportResults: (request) => ipcRenderer.invoke(CHANNELS.exportResults, request),
  copySelection: (request) => ipcRenderer.invoke(CHANNELS.copySelection, request),
  onJobEvent: (listener) => {
    const wrapped = (_event: unknown, payload: JobEventDto): void => listener(payload);
    ipcRenderer.on(CHANNELS.jobEvent, wrapped as never);
    return () => {
      ipcRenderer.removeListener(CHANNELS.jobEvent, wrapped as never);
    };
  },
};

contextBridge.exposeInMainWorld("archiveRecon", bridge);
