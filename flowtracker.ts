import fs from 'fs';
import path from 'path';
import { HealFlow, HealStep, FlowTier } from './types';

/* ------------------------------------------------------------------ *
 *  flowTracker  (file-backed, one stable file per worker)
 *
 *  Persists each element on beginFlow (and every logStep / endFlow), so every
 *  element step() starts is on disk and appears in the dashboard — fixing
 *  "FLOW COUNT = 1". Flows are keyed by elementName and upserted, so an
 *  element evaluated twice yields one row (no duplicate "Select Product").
 *
 *  Writes the HealFlow shape the dashboard (renderHtml) expects, stamping a
 *  1-based `order` on each step for the detail table.
 *
 *  Keep FLOW_DIR / filename in sync with SelfHealingReporter.ts.
 * ------------------------------------------------------------------ */
export const FLOW_DIR = path.join(process.cwd(), 'self-healing-output', 'flows');
const FLOW_FILE = path.join(FLOW_DIR, `flows-${process.pid}.json`);

const flows = new Map<string, HealFlow>();
let current: HealFlow | null = null;

function ensureDir(): void {
  if (!fs.existsSync(FLOW_DIR)) fs.mkdirSync(FLOW_DIR, { recursive: true });
}

function flushToDisk(): void {
  try {
    ensureDir();
    fs.writeFileSync(FLOW_FILE, JSON.stringify(Array.from(flows.values()), null, 2), 'utf-8');
  } catch (e) {
    console.warn(`flowTracker: failed to write ${FLOW_FILE}: ${String(e)}`);
  }
}

export function beginFlow(elementName: string, testTitle: string, url: string): void {
  const flow: HealFlow = {
    elementName,
    testTitle,
    url,
    steps: [],
    finalTier: null,
    finalLocator: null,
    healed: false,
    writtenBack: false,
    startedAt: Date.now(),
    endedAt: null,
  };
  flows.set(elementName, flow); // upsert by elementName — never duplicates
  current = flow;
  flushToDisk();                // persist on START so element always shows
  console.log(`[FLOW BEGIN] ${elementName} — total tracked: ${flows.size}`);
}

export function logStep(step: Omit<HealStep, 'order'> & { order?: number }): void {
  let target = current;
  if (!target) {
    const all = Array.from(flows.values());
    target = all[all.length - 1] ?? null;
  }
  if (!target) {
    console.warn(`flowTracker.logStep: no flow to attach ${JSON.stringify(step)}`);
    return;
  }
  target.steps.push({ ...step, order: step.order ?? target.steps.length + 1 });
  flushToDisk();
}

export function endFlow(result: {
  finalTier: FlowTier | null;
  finalLocator: string | null;
  healed: boolean;
  writtenBack: boolean;
}): void {
  if (!current) {
    const all = Array.from(flows.values());
    current = all.reverse().find((f) => f.endedAt == null) ?? null;
    if (!current) return;
  }
  current.finalTier = result.finalTier;
  current.finalLocator = result.finalLocator;
  current.healed = result.healed;
  current.writtenBack = result.writtenBack;
  current.endedAt = Date.now();
  console.log(`[FLOW END] ${current.elementName} -> tier=${result.finalTier ?? 'null'}`);
  current = null;
  flushToDisk();
}

export function getFlows(): HealFlow[] {
  return Array.from(flows.values());
}

export function resetFlows(): void {
  flows.clear();
  current = null;
  try {
    if (fs.existsSync(FLOW_FILE)) fs.unlinkSync(FLOW_FILE);
  } catch {
    /* best-effort */
  }
}
