import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";

/**
 * Client IP for rate limiting.
 * Prefer Express req.ip (honors trust proxy). Do NOT take the leftmost
 * X-Forwarded-For entry blindly — clients can spoof that header.
 */
function clientIp(req: Request): string {
  if (typeof req.ip === "string" && req.ip) {
    return req.ip;
  }
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real.trim()) return real.trim();
  // Last resort: right-most XFF hop (closest to us / added by our edge).
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.trim()) {
    const parts = xf.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1]!;
  }
  return req.socket.remoteAddress || "unknown";
}

/** Sliding-window in-memory limiter (per process). Fine for a single Railway replica. */
export function createIpRateLimiter(opts?: {
  max?: number;
  windowMs?: number;
  message?: string;
}) {
  const max = Math.max(1, Number(opts?.max ?? config.rateLimitMax) || 15);
  const windowMs = Math.max(
    1000,
    Number(opts?.windowMs ?? config.rateLimitWindowMs) || 60_000,
  );
  const message =
    opts?.message ?? "Too many checkout attempts; try again shortly";
  const hits = new Map<string, number[]>();

  const pruneEvery = Math.max(windowMs, 60_000);
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, times] of hits) {
      const kept = times.filter((t) => t > cutoff);
      if (kept.length) hits.set(ip, kept);
      else hits.delete(ip);
    }
  }, pruneEvery).unref?.();

  return function ipRateLimit(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const ip = clientIp(req);
    const now = Date.now();
    const cutoff = now - windowMs;
    const prior = (hits.get(ip) ?? []).filter((t) => t > cutoff);
    if (prior.length >= max) {
      res.setHeader("Retry-After", String(Math.ceil(windowMs / 1000)));
      res.setHeader("X-RateLimit-Limit", String(max));
      res.setHeader("X-RateLimit-Remaining", "0");
      console.warn(`[rate-limit] 429 ip=${ip} count=${prior.length}/${max}`);
      res.status(429).json({ error: message });
      return;
    }
    prior.push(now);
    hits.set(ip, prior);
    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(max - prior.length));
    next();
  };
}
