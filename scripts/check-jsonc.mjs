#!/usr/bin/env node
// Parse JSON with comments (the permission-system config is JSONC) without
// touching strings, so URLs such as https://... survive comment stripping.
import { readFileSync } from "node:fs";

function stripJsonComments(source) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    const next = source[i + 1];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (
        i < source.length &&
        !(source[i] === "*" && source[i + 1] === "/")
      ) {
        i += 1;
      }
      i += 1;
      continue;
    }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("usage: check-jsonc.mjs <file...>");
  process.exit(2);
}
let failed = false;
for (const path of paths) {
  try {
    JSON.parse(stripJsonComments(readFileSync(path, "utf8")));
    console.log(`ok ${path}`);
  } catch (error) {
    failed = true;
    console.error(`invalid ${path}: ${error.message}`);
  }
}
process.exit(failed ? 1 : 0);
