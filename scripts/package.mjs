#!/usr/bin/env node
// scripts/package.mjs — 生成符合 dbx manifest v1 的 polaris-api 通用 .dbxp 包。
//
//   node scripts/package.mjs          # 产出 dist/polaris-api-0.1.0-universal.dbxp
//
// 约束（对齐 dbx 打包规则）：
//   - 只收录 manifest.json、dbx-plugin.toml、assets/**、ui/**；
//   - 不使用符号链接；路径扁平；每个文件被 checksums 恰好覆盖一次；
//   - 生成校验和，作为开发态未签名包（可加 --dev 标识）。
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, createReadStream, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = resolve(fileURLToPath(import.meta.url), "..", "..");
const root = __dirname;
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf-8"));
const id = manifest.id;
const version = manifest.version;
const packageName = `${id}-${version}-universal.dbxp`;
const outDir = join(root, "dist");
mkdirSync(outDir, { recursive: true });

/** 递归收集 include 目录下全部文件（相对根的正斜杠路径） */
function collectFiles() {
  const included = [];
  const walk = (dir, pathIn = "") => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const rel = pathIn ? `${pathIn}/${entry}` : entry;
      if (statSync(full).isDirectory()) walk(full, rel);
      else included.push(rel);
    }
  };
  walk(join(root, "assets"), "assets");
  walk(join(root, "ui"), "ui");
  included.push("manifest.json");
  included.push("dbx-plugin.toml");
  return included;
}

/** 只读一次文件内容，用于写入 + 计算 sha256 */
function readChunk(p) {
  return readFileSync(join(root, p));
}

async function main() {
  if (!existsSync(join(root, "ui/index.html"))) throw new Error("缺少 ui/index.html");
  const files = collectFiles();
  if (files.includes("checksums.json") || files.includes("signature.json")) {
    throw new Error("不应收录打包期自动生成的 checksums/signature");
  }

  // 先计算 sha256（含 path）
  const checksums = {};
  const contents = new Map();
  for (const f of files) {
    const buf = readChunk(f);
    contents.set(f, buf);
    checksums[f] = createHash("sha256").update(buf).digest("hex");
  }

  // 逐项校验 schema 约束（避免把非法 package 打包出去）
  const uiEntry = manifest.entrypoints && manifest.entrypoints.ui;
  if (!uiEntry || !uiEntry.entry) throw new Error("manifest 缺少 ui entrypoints");
  if (!files.includes(uiEntry.entry)) throw new Error(`ui 入口 ${uiEntry.entry} 不在打包文件里`);
  if (manifest.manifest_version !== 1) throw new Error("manifest_version 必须为 1");
  if (!manifest.id || !manifest.version || !manifest.publisher) throw new Error("缺少 id/version/publisher");

  // 生成 .dbxp（ZIP 容器）。手动拼一个最小但有效的 ZIP（stored 无压缩，支持所有平台）
  const zipBuf = await buildZip([...files, "checksums.json"], (f) => f === "checksums.json" ? Buffer.from(JSON.stringify({ hash: "sha256", files: checksums }, null, 2)) : contents.get(f));

  const outPath = join(outDir, packageName);
  writeFileSync(outPath, zipBuf);
  console.log(`✓ 生成 ${outPath} (${(zipBuf.length / 1024).toFixed(1)} KB, ${files.length} 个文件)`);
  console.log(`  已内嵌 checksums.json（开发态未签名包）`);
}

/* ---------- 最小 ZIP（stored） ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function buildZip(paths, read) {
  const local = [];
  const central = [];
  let offset = 0;
  let index = 0;
  for (const p of paths) {
    const name = Buffer.from(p, "utf-8");
    const data = read(p);
    const crc = crc32(data);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); // local file header sig
    lfh.writeUInt16LE(20, 4);         // version needed
    lfh.writeUInt16LE(0, 6);          // flags
    lfh.writeUInt16LE(0, 8);          // method stored
    lfh.writeUInt16LE(0, 10);         // mod time
    lfh.writeUInt16LE(0, 12);         // mod date
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(name.length, 26);
    lfh.writeUInt16LE(0, 28);         // extra len
    local.push(lfh, name, data);

    const ce = Buffer.alloc(46);
    ce.writeUInt32LE(0x02014b50, 0);  // central dir sig
    ce.writeUInt16LE(20, 4);
    ce.writeUInt16LE(20, 6);
    ce.writeUInt16LE(0, 8);
    ce.writeUInt16LE(0, 10);
    ce.writeUInt16LE(0, 12);
    ce.writeUInt32LE(crc, 16);
    ce.writeUInt32LE(data.length, 20);
    ce.writeUInt32LE(data.length, 24);
    ce.writeUInt16LE(name.length, 28);
    ce.writeUInt16LE(0, 30);
    ce.writeUInt16LE(0, 32);
    ce.writeUInt16LE(0, 34);
    ce.writeUInt16LE(0, 36);
    ce.writeUInt32LE(0, 38);          // external attr
    ce.writeUInt32LE(offset, 42);     // local offset
    central.push(ce, name);

    offset += 30 + name.length + data.length;
    index++;
  }
  const cdStart = offset;
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(paths.length, 8);
  eocd.writeUInt16LE(paths.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...local, ...central, eocd]);
}

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

main().catch((err) => { console.error("打包失败:", err.message); process.exit(1); });
