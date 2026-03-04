import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { Server } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@dezhou/shared";
import { TableEngine } from "./table-engine.js";
import { AuditLogger } from "./audit-logger.js";

const PORT = Number(process.env.PORT ?? 3000);
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";

const app = express();
app.use(cors({ origin: WEB_ORIGIN }));
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const server = createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
  cors: { origin: WEB_ORIGIN }
});

const logger = new AuditLogger("./data/audit.log");

const engine = new TableEngine({
  onTableState: (playerId, state) => {
    const socketId = engine.getSocketId(playerId);
    if (socketId) {
      io.to(socketId).emit("table:state", state);
    }
  },
  onStateChanged: (playerId, partial) => {
    const socketId = engine.getSocketId(playerId);
    if (socketId) {
      io.to(socketId).emit("game:stateChanged", partial);
    }
  },
  onActionEvent: (playerId, event) => {
    const socketId = engine.getSocketId(playerId);
    if (socketId) {
      io.to(socketId).emit("game:actionEvent", event);
    }
  },
  onHandResult: (playerId, result) => {
    const socketId = engine.getSocketId(playerId);
    if (socketId) {
      io.to(socketId).emit("game:handResult", result);
    }
  },
  onNotice: (playerId, notice) => {
    const socketId = engine.getSocketId(playerId);
    if (socketId) {
      io.to(socketId).emit("system:notice", notice);
    }
  },
  onAudit: (event) => logger.write(event)
});

io.on("connection", (socket) => {
  socket.on("player:join", (payload, ack) => {
    const res = engine.join({ nickname: payload.nickname, token: payload.reconnectToken, socketId: socket.id });
    if (res.ok && res.playerId) {
      socket.data.playerId = res.playerId;
    }
    ack(res);
  });

  socket.on("player:sit", (payload, ack) => {
    const playerId = socket.data.playerId as string | undefined;
    if (!playerId) {
      ack({ ok: false, reason: "请先加入" });
      return;
    }
    ack(engine.sit(playerId, payload.seatIndex));
  });

  socket.on("player:leaveSeat", (ack) => {
    const playerId = socket.data.playerId as string | undefined;
    if (!playerId) {
      ack({ ok: false, reason: "请先加入" });
      return;
    }
    ack(engine.leaveSeat(playerId));
  });

  socket.on("game:action", (payload, ack) => {
    const playerId = socket.data.playerId as string | undefined;
    if (!playerId) {
      ack({ ok: false, reason: "请先加入" });
      return;
    }
    const res = engine.applyAction(playerId, payload);
    ack(res);
    socket.emit("game:actionAck", res);
  });

  socket.on("player:rebuy", (ack) => {
    const playerId = socket.data.playerId as string | undefined;
    if (!playerId) {
      ack({ ok: false, reason: "请先加入" });
      return;
    }
    ack(engine.rebuy(playerId));
  });

  socket.on("player:ready", (payload, ack) => {
    const playerId = socket.data.playerId as string | undefined;
    if (!playerId) {
      ack({ ok: false, reason: "请先加入" });
      return;
    }
    ack(engine.setReady(playerId, payload.ready));
  });

  socket.on("host:startHand", (ack) => {
    const playerId = socket.data.playerId as string | undefined;
    if (!playerId) {
      ack({ ok: false, reason: "请先加入" });
      return;
    }
    ack(engine.startHandByHost(playerId));
  });

  socket.on("host:startNextHand", (ack) => {
    const playerId = socket.data.playerId as string | undefined;
    if (!playerId) {
      ack({ ok: false, reason: "请先加入" });
      return;
    }
    ack(engine.startHandByHost(playerId));
  });

  socket.on("disconnect", () => {
    const playerId = socket.data.playerId as string | undefined;
    if (!playerId) {
      return;
    }
    engine.disconnect(playerId, socket.id);
  });
});

setInterval(() => {
  engine.tick();
}, 1_000);

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`dezhou server running on http://localhost:${PORT}`);
});
