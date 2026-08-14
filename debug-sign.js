// 窃听版 glue：看 WASM 到底从环境里读了什么
const fs = require("fs");
const path = require("path");
const wasmBytes = fs.readFileSync(path.join(__dirname, "wasm_encrypt.wasm"));

let En, Tu = 0;
const te = new TextEncoder();
const td = new TextDecoder("utf-8");
let dv0 = null;

function W1() {
  if (dv0 === null || dv0.buffer !== En.memory.buffer) dv0 = new DataView(En.memory.buffer);
  return dv0;
}
function Vh(arg, malloc, realloc) {
  let len = arg.length;
  let ptr = malloc(len, 1) >>> 0;
  const mem = new Uint8Array(En.memory.buffer);
  let offset = 0;
  for (; offset < len; offset++) {
    const code = arg.charCodeAt(offset);
    if (code > 0x7f) break;
    mem[ptr + offset] = code;
  }
  if (offset !== len) {
    if (offset !== 0) arg = arg.slice(offset);
    len = offset;
    const buf = te.encode(arg);
    ptr = realloc(ptr, len, (len += buf.length), 1) >>> 0;
    new Uint8Array(En.memory.buffer, ptr + len - buf.length, buf.length).set(buf);
    Tu = len;
    return ptr;
  }
  Tu = len;
  return ptr;
}
function Sd(ptr, len) {
  len = len >>> 0;
  return td.decode(new Uint8Array(En.memory.buffer, ptr, len));
}
function ts(x) { return x == null; }
function Ei(obj) {
  const idx = En.__externref_table_alloc();
  En.__wbindgen_externrefs.set(idx, obj);
  return idx;
}
function sv(f, a) {
  try { return f(...a); } catch (e) { En.__wbindgen_exn_store(Ei(e)); }
}
// 把 externref 索引还原成可读描述
function desc(t) {
  try {
    if (t === undefined) return "undefined";
    if (t === null) return "null";
    const v = En.__wbindgen_externrefs.get(t);
    if (v === undefined) return "undef-ref";
    return typeof v === "object" ? Object.prototype.toString.call(v) : `${typeof v}:${String(v).slice(0, 80)}`;
  } catch { return "?"; }
}

const imports = {
  "./wasm_encrypt_bg.js": {
    __wbg___wbindgen_boolean_get_c0f3f60bac5a78d1: (t) => {
      const o = typeof t === "boolean" ? t : void 0;
      return ts(o) ? 16777215 : o ? 1 : 0;
    },
    __wbg___wbindgen_is_undefined_52709e72fb9f179c: (t) => {
      console.log("  [is_undefined]", desc(t));
      return t === void 0;
    },
    __wbg___wbindgen_string_get_395e606bd0ee4427: (t, n) => {
      const s = typeof n === "string" ? n : void 0;
      const r = ts(s) ? 0 : Vh(s, En.__wbindgen_malloc, En.__wbindgen_realloc);
      W1().setInt32(t + 4, Tu, true);
      W1().setInt32(t + 0, r, true);
    },
    __wbg___wbindgen_throw_6ddd609b62940d55: (t, n) => { throw new Error(Sd(t, n)); },
    __wbg_getOwnPropertyDescriptor_99c5c66035afe95e: function () {
      const a = arguments;
      console.log("  [getOwnPropertyDescriptor]", desc(a[0]), String(a[1]).slice(0, 60));
      return sv((t, n) => Reflect.getOwnPropertyDescriptor(t, n), a);
    },
    __wbg_get_3ef1eba1850ade27: function () {
      const a = arguments;
      console.log("  [Reflect.get]", desc(a[0]), String(a[1]).slice(0, 60));
      return sv((t, n) => Reflect.get(t, n), a);
    },
    __wbg_has_926ef2ff40b308cf: function () {
      const a = arguments;
      console.log("  [Reflect.has]", desc(a[0]), String(a[1]).slice(0, 60));
      return sv((t, n) => Reflect.has(t, n), a);
    },
    __wbg_new_no_args_d15c5c26a5dbe2e7: (t, n) => {
      const code = Sd(t, n);
      console.log("  [new Function]", JSON.stringify(code).slice(0, 120));
      return new Function(code)();
    },
    __wbg_static_accessor_GLOBAL_8adb955bd33fac2f: () => {
      const t = typeof global === "undefined" ? null : global;
      console.log("  [accessor GLOBAL]");
      return ts(t) ? 0 : Ei(t);
    },
    __wbg_static_accessor_GLOBAL_THIS_ad356e0db91c7913: () => {
      const t = typeof globalThis === "undefined" ? null : globalThis;
      console.log("  [accessor GLOBAL_THIS]");
      return ts(t) ? 0 : Ei(t);
    },
    __wbg_static_accessor_SELF_f207c857566db248: () => {
      const t = typeof self === "undefined" ? null : self;
      console.log("  [accessor SELF]");
      return ts(t) ? 0 : Ei(t);
    },
    __wbg_static_accessor_WINDOW_bb9f1ba69d61b386: () => {
      const t = typeof window === "undefined" ? null : window;
      console.log("  [accessor WINDOW]");
      return ts(t) ? 0 : Ei(t);
    },
    __wbg_toString_04ebde4c127f09ae: (t) => {
      const s = t && t.toString ? t.toString() : String(t);
      console.log("  [toString]", String(s).slice(0, 120));
      return s;
    },
    __wbindgen_cast_0000000000000001: (t, n) => Sd(t, n),
    __wbindgen_init_externref_table: () => {
      const t = En.__wbindgen_externrefs;
      const n = t.grow(4);
      t.set(0, void 0); t.set(n + 0, void 0); t.set(n + 1, null); t.set(n + 2, true); t.set(n + 3, false);
    },
  },
};

async function main() {
  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
  En = instance.exports;
  const time = "1786696339", openId = "ou_987c0fdfb792a3c3e420075e4b151120";
  console.log("=== get_sign 开始 ===");
  const a = Vh(time, En.__wbindgen_malloc, En.__wbindgen_realloc), r = Tu;
  const l = Vh(openId, En.__wbindgen_malloc, En.__wbindgen_realloc), i = Tu;
  const u = En.get_sign(a, r, l, i);
  console.log("=== 结果 ===", Sd(u[0], u[1]));
}
main();
