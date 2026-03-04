import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { createClient } from "redis";
import { Pool } from "pg";
import type { ClientToServerEvents, ServerToClientEvents } from "@dezhou/shared";
import { TableEngine } from "./table-engine.js";
import { AuditLogger } from "./audit-logger.js";
import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";
import { MetricsRegistry } from "./metrics.js";
import { SlidingWindowLimiter } from "./rate-limit.js";
import { RedisStateStore } from "./state-store.js";
import { PgAuditStore } from "./audit-store.js";

async function bootstrap(): Promise<void> {
  const cfg = loadConfig();
  const logger = new Logger(cfg.logLevel);
  const metrics = new MetricsRegistry();

  const redis = createClient({ url: cfg.redisUrl });
  redis.on("error", (error) => {
    metrics.increment("errors_total");
    logger.error("redis error", { error: error instanceof Error ? error.message : String(error) });
  });
  await redis.connect();

  const pgPool = new Pool({ connectionString: cfg.postgresUrl });
  await pgPool.query("SELECT 1");

  const stateStore = new RedisStateStore(redis, "table:main");
  const fileAuditLogger = new AuditLogger("./data/audit.log");
  const pgAuditStore = new PgAuditStore(pgPool);
  await pgAuditStore.init();

  const httpLimiter = new SlidingWindowLimiter(cfg.rateLimitWindowMs, cfg.rateLimitMax);
  const socketLimiter = new SlidingWindowLimiter(cfg.socketRateLimitWindowMs, cfg.socketRateLimitMax);

  const app = express();

  app.use((req: Request, res: Response, next: NextFunction) => {
    const clientKey = req.ip || req.socket.remoteAddress || "unknown";
    if (!httpLimiter.take(clientKey)) {
      res.status(429).json({ ok: false, reason: "请求过于频繁，请稍后重试" });
      return;
    }
    next();
  });

  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin || cfg.webOrigins.includes(origin)) {
          cb(null, true);
          return;
        }
        cb(new Error("CORS blocked"));
      }
    })
  );

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/ready", async (_req, res) => {
    const detail: Record<string, boolean> = { redis: false, postgres: false };
    try {
      await redis.ping();
      detail.redis = true;
    } catch {
      detail.redis = false;
    }
    try {
      await pgPool.query("SELECT 1");
      detail.postgres = true;
    } catch {
      detail.postgres = false;
    }
    const ok = detail.redis && detail.postgres;
    res.status(ok ? 200 : 503).json({ ok, detail });
  });

  app.get("/metrics", (_req, res) => {
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.send(metrics.renderPrometheus());
  });

  const server = createServer(app);
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
    cors: { origin: cfg.webOrigins }
  });

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
    onAudit: (event) => {
      fileAuditLogger.write(event);
      if (event.type === "hand_start") {
        metrics.increment("hands_started_total");
      }
      if (event.type === "hand_end") {
        metrics.increment("hands_finished_total");
      }
      if (event.type === "action" && event.isAuto) {
        metrics.increment("timeouts_auto_total");
      }
      void pgAuditStore.write(event).catch((error) => {
        metrics.increment("errors_total");
        logger.error("audit write failed", { error: error instanceof Error ? error.message : String(error) });
      });
      schedulePersist();
    }
  });

  let persistPending = false;
  const persistNow = async (): Promise<void> => {
    if (persistPending) {
      return;
    }
    persistPending = true;
    try {
      await stateStore.save(engine.dumpSnapshot());
    } catch (error) {
      metrics.increment("errors_total");
      logger.error("state persist failed", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      persistPending = false;
    }
  };

  const schedulePersist = (): void => {
    void persistNow();
  };

  try {
    const snapshot = await stateStore.load();
    if (snapshot) {
      const restored = engine.restoreFromSnapshot(snapshot);
      if (!restored.ok) {
        logger.warn("state restore skipped", { reason: restored.reason });
      } else {
        logger.info("state restored", { savedAt: snapshot.savedAt });
      }
    }
  } catch (error) {
    metrics.increment("errors_total");
    logger.warn("state restore failed; fallback to fresh waiting state", {
      error: error instanceof Error ? error.message : String(error)
    });
  }

  const isSocketAllowed = (socketId: string, event: string): boolean => socketLimiter.take(`${socketId}:${event}`);

  io.on("connection", (socket) => {
    socket.on("player:join", (payload, ack) => {
      if (!isSocketAllowed(socket.id, "player:join")) {
        ack({ ok: false, reason: "请求过于频繁，请稍后再试" });
        return;
      }
      const res = engine.join({ nickname: payload.nickname, token: payload.reconnectToken, socketId: socket.id });
      if (res.ok && res.playerId) {
        socket.data.playerId = res.playerId;
      }
      if (payload.reconnectToken && res.ok) {
        metrics.increment("reconnect_total");
      }
      if (res.ok) {
        schedulePersist();
      }
      ack(res);
    });

    socket.on("player:sit", (payload, ack) => {
      if (!isSocketAllowed(socket.id, "player:sit")) {
        ack({ ok: false, reason: "请求过于频繁，请稍后再试" });
        return;
      }
      const playerId = socket.data.playerId as string | undefined;
      if (!playerId) {
        ack({ ok: false, reason: "请先加入" });
        return;
      }
      const res = engine.sit(playerId, payload.seatIndex);
      if (res.ok) {
        schedulePersist();
      }
      ack(res);
    });

    socket.on("player:leaveSeat", (ack) => {
      if (!isSocketAllowed(socket.id, "player:leaveSeat")) {
        ack({ ok: false, reason: "请求过于频繁，请稍后再试" });
        return;
      }
      const playerId = socket.data.playerId as string | undefined;
      if (!playerId) {
        ack({ ok: false, reason: "请先加入" });
        return;
      }
      const res = engine.leaveSeat(playerId);
      if (res.ok) {
        schedulePersist();
      }
      ack(res);
    });

    socket.on("game:action", (payload, ack) => {
      if (!isSocketAllowed(socket.id, "game:action")) {
        ack({ ok: false, reason: "请求过于频繁，请稍后再试" });
        return;
      }
      const playerId = socket.data.playerId as string | undefined;
      if (!playerId) {
        ack({ ok: false, reason: "请先加入" });
        return;
      }
      const res = engine.applyAction(playerId, payload);
      if (!res.ok) {
        metrics.increment("errors_total");
      } else {
        schedulePersist();
      }
      ack(res);
      socket.emit("game:actionAck", res);
    });

    socket.on("player:rebuy", (ack) => {
      if (!isSocketAllowed(socket.id, "player:rebuy")) {
        ack({ ok: false, reason: "请求过于频繁，请稍后再试" });
        return;
      }
      const playerId = socket.data.playerId as string | undefined;
      if (!playerId) {
        ack({ ok: false, reason: "请先加入" });
        return;
      }
      const res = engine.rebuy(playerId);
      if (res.ok) {
        schedulePersist();
      }
      ack(res);
    });

    socket.on("player:ready", (payload, ack) => {
      if (!isSocketAllowed(socket.id, "player:ready")) {
        ack({ ok: false, reason: "请求过于频繁，请稍后再试" });
        return;
      }
      const playerId = socket.data.playerId as string | undefined;
      if (!playerId) {
        ack({ ok: false, reason: "请先加入" });
        return;
      }
      const res = engine.setReady(playerId, payload.ready);
      if (res.ok) {
        schedulePersist();
      }
      ack(res);
    });

    socket.on("host:startHand", (ack) => {
      if (!isSocketAllowed(socket.id, "host:startHand")) {
        ack({ ok: false, reason: "请求过于频繁，请稍后再试" });
        return;
      }
      const playerId = socket.data.playerId as string | undefined;
      if (!playerId) {
        ack({ ok: false, reason: "请先加入" });
        return;
      }
      const res = engine.startHandByHost(playerId);
      if (res.ok) {
        schedulePersist();
      }
      ack(res);
    });

    socket.on("host:startNextHand", (ack) => {
      if (!isSocketAllowed(socket.id, "host:startNextHand")) {
        ack({ ok: false, reason: "请求过于频繁，请稍后再试" });
        return;
      }
      const playerId = socket.data.playerId as string | undefined;
      if (!playerId) {
        ack({ ok: false, reason: "请先加入" });
        return;
      }
      const res = engine.startHandByHost(playerId);
      if (res.ok) {
        schedulePersist();
      }
      ack(res);
    });

    socket.on("disconnect", () => {
      const playerId = socket.data.playerId as string | undefined;
      if (!playerId) {
        return;
      }
      engine.disconnect(playerId, socket.id);
      metrics.increment("disconnect_total");
      schedulePersist();
    });
  });

  setInterval(() => {
    engine.tick();
    schedulePersist();
  }, 1_000);

  setInterval(() => {
    schedulePersist();
  }, cfg.persistIntervalMs);

  server.listen(cfg.port, () => {
    logger.info("dezhou server running", { port: cfg.port, origins: cfg.webOrigins });
  });
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      message: "server bootstrap failed",
      error: error instanceof Error ? error.message : String(error)
    })
  );
  process.exit(1);
});
