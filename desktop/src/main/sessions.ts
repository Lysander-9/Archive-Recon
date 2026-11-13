/** Per-task Electron session isolation: proxy applied before any request, no direct fallback. */

import { session as electronSession, type Session } from "electron";
import type { JobSession, SessionFactory, Transport } from "../application/ports";
import type { ProxySpec } from "../contracts/types";
import { buildProxyConfig, proxySnapshot } from "./adapters/proxy";

export interface ElectronSessionFactory extends SessionFactory {
  sessions: Map<number, Session>;
}

export function createElectronSessions(): ElectronSessionFactory {
  const sessions = new Map<number, Session>();

  return {
    sessions,
    async create(jobId: number, proxy: ProxySpec): Promise<JobSession> {
      const config = buildProxyConfig(proxy);
      const isolated = electronSession.fromPartition(`archive-job-${jobId}`, { cache: false });
      await isolated.setProxy(config);
      sessions.set(jobId, isolated);
      const transport: Transport = async (url, init) => {
        const response = await isolated.fetch(url, {
          signal: init?.signal,
          headers: init?.headers,
          bypassCustomProtocolHandlers: true,
        });
        return response;
      };
      return { transport, proxy: proxySnapshot(proxy) };
    },
    async close(jobId: number): Promise<void> {
      const isolated = sessions.get(jobId);
      sessions.delete(jobId);
      if (!isolated) return;
      try {
        await isolated.clearCache();
      } catch {
        // best effort
      }
      try {
        await isolated.closeAllConnections();
      } catch {
        // best effort
      }
    },
  };
}
