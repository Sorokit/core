#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../src");
const ci = process.argv.includes("--ci");
const json = process.argv.includes("--json");
function files(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => { const file = path.join(dir, entry.name); return entry.isDirectory() ? files(file) : /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [file] : []; }); }
const allFiles = files(root).map((file) => path.resolve(file)); const known = new Set(allFiles);
function resolveImport(from, value) { if (!value.startsWith(".")) return null; const base = path.resolve(path.dirname(from), value); for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) if (known.has(candidate)) return candidate; return null; }
const graph = new Map(allFiles.map((file) => [file, []]));
for (const file of allFiles) for (const match of fs.readFileSync(file, "utf8").matchAll(/(?:import|export)\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g)) { const target = resolveImport(file, match[1]); if (target) graph.get(file).push(target); }
let index = 0; const stack = []; const onStack = new Set(); const indexes = new Map(); const low = new Map(); const cycles = [];
function visit(node) { indexes.set(node, index); low.set(node, index++); stack.push(node); onStack.add(node); for (const next of graph.get(node)) { if (!indexes.has(next)) { visit(next); low.set(node, Math.min(low.get(node), low.get(next))); } else if (onStack.has(next)) low.set(node, Math.min(low.get(node), indexes.get(next))); } if (low.get(node) === indexes.get(node)) { const component = []; let current; do { current = stack.pop(); onStack.delete(current); component.push(current); } while (current !== node); if (component.length > 1 || graph.get(component[0]).includes(component[0])) cycles.push(component); } }
for (const file of graph.keys()) if (!indexes.has(file)) visit(file);
const report = { files: graph.size, edges: [...graph.values()].reduce((n, edges) => n + edges.length, 0), cycles: cycles.map((cycle) => cycle.map((file) => path.relative(process.cwd(), file))) };
if (json) console.log(JSON.stringify(report, null, 2)); else { console.log(`Dependency graph: ${report.files} files, ${report.edges} edges`); if (!report.cycles.length) console.log("No circular dependencies detected."); else report.cycles.forEach((cycle, i) => console.log(`Cycle ${i + 1}: ${cycle.join(" -> ")} -> ${cycle[0]}`)); }
if (ci && cycles.length) process.exitCode = 1;
