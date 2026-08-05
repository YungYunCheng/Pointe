import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import fs from "node:fs";
import path from "node:path";
import { db, DATA_DIR } from "./db.js";
import { syncRbac } from "./rbac.js";
import authRoutes from "./routes/auth.js";
import coreRoutes from "./routes/core.js";
import workflowRoutes from "./routes/workflow.js";
import adminRoutes from "./routes/admin.js";
import accountingRoutes from "./routes/accounting.js";
import opsRoutes from "./routes/ops.js";
import crmRoutes from "./routes/crm.js";
import agreementRoutes from "./routes/agreements.js";
import ops2Routes from "./routes/ops2.js";
import aiRoutes from "./routes/ai.js";
import tenantRoutes from "./routes/tenant.js";
import { startBackupJob, startDailyJobs } from "./jobs.js";
import { startAccountingJobs } from "./jobs-accounting.js";
import { ensureSeed } from "./seed.js";

/* A restore requested through the API is completed here, at startup, while no
   connections are open. */
const pendingPath = path.join(DATA_DIR, "RESTORE_PENDING");
if (fs.existsSync(pendingPath)) {
  const req = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
  console.log(`[restore] restoring from ${req.from} (requested by ${req.requested_by} at ${req.at})`);
  db.close();
  fs.copyFileSync(req.from, path.join(DATA_DIR, "baydo.db"));
  fs.unlinkSync(pendingPath);
  console.log("[restore] done. Start the server again.");
  process.exit(0);
}

syncRbac();
ensureSeed();

const app = express();
const PORT = process.env.PORT || 4000;

app.set("trust proxy", 1);
app.use(cors({
  origin: (process.env.CORS_ORIGINS || "http://localhost:3000,http://localhost:5173").split(","),
  credentials: true,
}));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

app.get("/health", (req, res) => res.json({ ok: true, at: new Date().toISOString() }));

app.use("/api/auth", authRoutes);
app.use("/api", coreRoutes);
app.use("/api", workflowRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/accounting", accountingRoutes);
app.use("/api", opsRoutes);
app.use("/api", crmRoutes);
app.use("/api", agreementRoutes);
app.use("/api", ops2Routes);
app.use("/api", tenantRoutes);
app.use("/api", aiRoutes);

app.use("/api", (req, res) => res.status(404).json({ code: "NO_SUCH_ENDPOINT" }));

app.use((err, req, res, next) => {
  console.error("[error]", err.message);
  res.status(err.status || 500).json({ code: err.code || "SERVER_ERROR", message: err.message });
});

app.listen(PORT, () => {
  console.log(`\n  Baydo Pointe API  ->  http://localhost:${PORT}`);
  console.log(`  Health check      ->  http://localhost:${PORT}/health`);
  console.log(`  Database          ->  ${path.join(DATA_DIR, "baydo.db")}\n`);
  startBackupJob();
  startDailyJobs();
  startAccountingJobs();
});
