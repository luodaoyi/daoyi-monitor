import type { AdminEvent } from "../types";

export type WebSocketController = {
  close(): void;
};

export function connectAdminWs(onEvent: (event: AdminEvent) => void): WebSocketController {
  let closed = false;
  let ws: WebSocket | undefined;
  let retry = 500;

  const connect = () => {
    if (closed) return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${protocol}//${location.host}/ws/admin`);
    ws.onmessage = (event) => {
      onEvent(JSON.parse(event.data) as AdminEvent);
    };
    ws.onclose = () => {
      if (closed) return;
      window.setTimeout(connect, retry);
      retry = Math.min(retry * 2, 10000);
    };
    ws.onopen = () => {
      retry = 500;
      ws?.send(JSON.stringify({ type: "subscribe" }));
    };
  };

  connect();

  return {
    close() {
      closed = true;
      ws?.close();
    }
  };
}
