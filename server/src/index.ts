import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { monitor } from "@colyseus/monitor";
import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TallinnRoom } from "./rooms/TallinnRoom.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = Number(process.env.PORT || 2567);

// Health check (for load balancers + uptime probes).
app.get("/healthz", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Colyseus monitor for ops — protect in real prod, fine for MVP.
app.use("/colyseus", monitor());

// In production, serve the built client bundle.
const clientDist = path.resolve(__dirname, "../../client/dist");
app.use(express.static(clientDist));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/matchmake") || req.path.startsWith("/colyseus") || req.path.startsWith("/healthz")) {
    return next();
  }
  res.sendFile(path.join(clientDist, "index.html"), (err) => {
    if (err) next();
  });
});

const httpServer = createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define("tallinn", TallinnRoom);

httpServer.listen(PORT, () => {
  console.log(`[tallinn-game] listening on :${PORT}`);
  console.log(`[tallinn-game] monitor: http://localhost:${PORT}/colyseus`);
});
