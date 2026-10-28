/* tools/smoke.mjs — importer.js 解析器冒烟测试（node 环境直接跑）。
 * 用法：node tools/smoke.mjs   （全部断言通过则退出码 0）
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

// importer.js 是 IIFE，往 window.POLARIS_API 挂载 —— 用最小 window shim 加载
const shim = `var window = globalThis;\n${readFileSync(resolve(__dirname, "../ui/importer.js"), "utf-8")}`;
new Function(shim)();
const PA = globalThis.POLARIS_API;

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

/* ---------- fixture: OpenAPI 3 ---------- */
const openapi = {
  openapi: "3.0.3",
  info: { title: "Pet Store", version: "1.0.0" },
  paths: {
    "/pets": {
      get: {
        summary: "List pets",
        tags: ["pets"],
        parameters: [
          { name: "limit", in: "query", required: false, schema: { type: "integer" }, description: "max pets" },
        ],
        responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Pet" } } } } } },
      },
      post: {
        summary: "Create pet",
        tags: ["pets"],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } } },
        responses: { "201": { description: "created" } },
      },
    },
    "/pets/{petId}": {
      get: {
        summary: "Get pet by id",
        parameters: [{ name: "petId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "ok" }, "404": { description: "not found" } },
      },
      delete: { summary: "Delete pet", responses: { "204": { description: "deleted" } } },
    },
  },
  components: { schemas: { Pet: { type: "object", required: ["id", "name"], properties: { id: { type: "integer" }, name: { type: "string" }, tag: { type: "string" } } } } },
};

console.log("== OpenAPI 3 解析 ==");
const r1 = PA.loadOpenAPI(JSON.stringify(openapi));
ok(!!r1, "返回非空");
ok(r1.format === "OpenAPI" && r1.version === "3.0.3", "识别 OpenAPI 3.0.3");
ok(r1.endpointCount === 4, `端点数 = 4 (实际 ${r1.endpointCount})`);
ok(r1.root.name === "Pet Store", "根组名 = Pet Store");
ok(r1.root.children.some((c) => c.kind === "group" && c.name === "pets"), "按 tag 建组 pets");
const petsGroup = r1.root.children.find((c) => c.name === "pets");
ok(petsGroup.children.length === 4, "pets 组含 4 个端点");
const getPet = petsGroup.children.find((e) => e.method === "GET" && e.path === "/pets/{petId}");
ok(!!getPet, "找到 GET /pets/{petId}");
ok(getPet.query.length === 0 && getPet.params.length === 1 && getPet.params[0].required, "petId 是 path 参数且必填");
const postPet = petsGroup.children.find((e) => e.method === "POST");
ok(postPet.body && postPet.body.contentType === "application/json" && postPet.body.schema.includes("Pet"), "POST 请求体解析含 Pet schema");
ok(getPet.responses.length === 2, "GET /pets/{petId} 有 2 个响应");

/* ---------- fixture: Postman v2.1 ---------- */
const postman = {
  info: { name: "Demo API", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  item: [
    {
      name: "Users",
      item: [
        {
          name: "Get users",
          request: {
            method: "GET",
            url: { raw: "https://api.example.com/users?page=1", path: ["users"], query: [{ key: "page", value: "1" }] },
            header: [{ key: "Accept", value: "application/json" }],
          },
        },
        {
          name: "Create user",
          request: {
            method: "POST",
            url: "https://api.example.com/users",
            header: [{ key: "Content-Type", value: "application/json" }],
            body: { mode: "raw", raw: "{\"name\":\"Ada\"}" },
          },
        },
      ],
    },
  ],
};

console.log("== Postman v2.1 解析 ==");
const r2 = PA.loadPostman(JSON.stringify(postman));
ok(!!r2, "返回非空");
ok(r2.format === "Postman", "识别 Postman");
ok(r2.root.name === "Demo API", "根名 = Demo API");
ok(r2.root.children.length === 1 && r2.root.children[0].name === "Users", "组 Users 存在");
const users = r2.root.children[0];
ok(users.children.length === 2, "Users 含 2 个端点");
const getUsers = users.children.find((e) => e.method === "GET");
ok(getUsers.query.length === 1 && getUsers.query[0].name === "page", "query 参数 page 解析");
ok(getUsers.headers.length === 1 && getUsers.headers[0].name === "Accept", "header Accept 解析");
const createUser = users.children.find((e) => e.method === "POST");
ok(createUser.body && createUser.body.type === "raw" && createUser.body.schema.includes("Ada"), "raw 请求体解析");

/* ---------- 自动识别 / 兜底 ---------- */
console.log("== loadAuto 识别 ==");
ok(PA.loadAuto(JSON.stringify(openapi)).source === "openapi", "auto → openapi");
ok(PA.loadAuto(JSON.stringify(postman)).source === "postman", "auto → postman");
ok(PA.loadAuto("not json at all") === null, "非法输入返回 null");
ok(PA.loadAuto("[{\"method\":\"POST\",\"url\":\"/x\",\"name\":\"X\"}]").endpointCount === 1, "JSON 数组兜底导入 1 条");

/* ---------- 导出 ---------- */
console.log("== 导出 ==");
const curl = PA.toCurl(postPet);
ok(curl.includes("curl --request POST") && curl.includes("/pets"), "cURL 含方法与路径");
ok(curl.includes("Content-Type: application/json"), "cURL 含 Content-Type");
const md = PA.toMarkdown(getPet);
ok(md.includes("## GET `/pets/{petId}`"), "Markdown 标题含方法与路径");
ok(md.includes("petId") && md.includes("404"), "Markdown 含参数与响应");

/* ---------- methodColor ---------- */
ok(PA.methodColor("GET") === "#22c55e" && PA.methodColor("DELETE") === "#ef4444", "方法配色");

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);