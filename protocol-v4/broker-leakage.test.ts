import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";
import { once } from "node:events";
import { createMessageReader, writeMessage } from "../broker/framing.ts";

function scanContent(content: string, source: string) {
    // Forbidden patterns: the specific scope literal and the environment variable name
    const forbidden = ["Scope_AAAAAAAAAA", "AGENT_INTERCOM_SCOPE_ID"];
    for (const pattern of forbidden) {
        if (content.includes(pattern)) {
            throw new Error(`Leakage detected (${pattern}) in: ${source}`);
        }
    }
}

function scanFiles(dir: string) {
    const files = readdirSync(dir, { recursive: true });
    for (const file of files) {
        const fullPath = join(dir, file as string);
        if (typeof file !== 'string' || (!file.endsWith(".jsonl") && !file.endsWith(".json"))) continue;
        const content = readFileSync(fullPath, "utf8");
        scanContent(content, fullPath);
    }
}

test("broker audit and files do not leak scope", { timeout: 20_000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), "leak-"));
    const intercomDir = join(home, "intercom");
    const broker = spawn(process.execPath, ["--import", "tsx", "broker/broker.ts"], {
        env: { ...process.env, PI_CODING_AGENT_DIR: home, HOME: home },
        stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    broker.stdout.on("data", (d) => { stdout += d.toString(); });
    broker.stderr.on("data", (d) => { stderr += d.toString(); });
    
    try {
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("broker startup timeout")), 10_000);
            broker.stdout.on("data", (d) => { if (d.toString().includes("Intercom broker started")) { clearTimeout(timeout); resolve(); } });
            broker.once("exit", (code) => reject(new Error(`broker exited: ${code}`)));
        });
        
        const sock = net.connect(join(intercomDir, "broker.sock"));
        await once(sock, "connect");
        writeMessage(sock, {
            type: "register",
            protocol: "pi-intercom",
            version: 4,
            scopeId: "Scope_AAAAAAAAAA",
            session: { name: "test", cwd: process.cwd(), model: "test", pid: process.pid, startedAt: Date.now(), lastActivity: Date.now() }
        });
        
        const reader = createMessageReader((m) => {
            if (m.type === "registered") sock.end();
        }, () => sock.destroy());
        sock.on("data", reader);
        await once(sock, "close");
        
        // Graceful shutdown
        broker.kill("SIGTERM");
        const exit = once(broker, "exit");
        await Promise.race([exit, new Promise((_, reject) => setTimeout(() => reject(new Error("Broker shutdown timeout")), 5000))]);
        
        // Scan logs/audit/output
        scanFiles(home);
        scanContent(stdout, "stdout");
        scanContent(stderr, "stderr");
        
    } finally {
        broker.kill("SIGKILL");
        rmSync(home, { recursive: true, force: true });
    }
});
