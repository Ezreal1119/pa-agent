import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

// Run the actual report renderer and handlers with a minimal DOM, without the
// page's login/polling bootstrap or a network/model dependency.
class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase();
    this.document = document;
    this.children = [];
    this.dataset = {};
    this.textContent = "";
    this.value = "";
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes) {
    this.children = nodes;
  }
  contains(node) {
    return this === node || this.children.some((c) => c.contains(node));
  }
  setAttribute(key, value) {
    this[key] = value;
  }
  focus() {
    this.document.activeElement = this;
  }
  set innerHTML(_) {
    throw Error("Untrusted suggestions must be rendered as text");
  }
}
const all = (node) => [node, ...node.children.flatMap(all)];

test("report suggestion is an explicit editable draft; only Re-Sync submits, old reports stay compatible", async () => {
  const document = { activeElement: null },
    nodes = new Map(),
    requests = [];
  document.createElement = (tag) => new Element(tag, document);
  document.createTextNode = (text) =>
    Object.assign(new Element("text", document), { textContent: text });
  document.getElementById = (id) => {
    if (!nodes.has(id)) nodes.set(id, new Element("div", document));
    return nodes.get(id);
  };
  const sandbox = vm.createContext({
    document,
    location: { hash: "", search: "" },
    URLSearchParams,
    File: class {},
    fetch: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return { status: 200, ok: true, json: async () => ({ id: "next" }) };
    },
  });
  const source = await fs.readFile("resources/web/synchronize.js", "utf8");
  vm.runInContext(
    source.slice(0, source.indexOf("async function refresh()")) +
      `
    async function refresh() {}
    choose = async () => {};
    globalThis.render = renderJob;
  `,
    sandbox,
  );
  const suggestion =
    "这是新产品 T5000，允许创建产品目录，创建 Hub、更新索引。<script>unsafe()</script>";
  const usage = { input: 0, output: 0, recorded: 0, requests: 0 };
  const item = {
    id: "file-a",
    name: "T5000.txt",
    status: "needs_review",
    stage: "Needs review",
    textUsage: usage,
    visualUsage: usage,
    feedback: "",
    plan: {
      decision: {
        products: ["T5000"],
        slot: "others",
        suggestedFeedback: suggestion,
      },
      changes: [],
    },
  };
  const job = {
    id: "job-a",
    kind: "sync",
    status: "completed",
    created: "2026-10-20T00:00:00Z",
    items: [item],
  };
  const elements = () => all(nodes.get("report"));
  const find = (text) => elements().find((n) => n.textContent === text);
  const textarea = () => elements().find((n) => n.tagName === "TEXTAREA");
  await sandbox.render(job);
  assert.equal(textarea().value, "");
  assert.ok(find(suggestion));
  assert.equal(requests.length, 0);
  await find("Use suggested instructions").onclick();
  assert.equal(textarea().value, suggestion);
  assert.equal(requests.length, 0);
  textarea().value = "这是 T5000 日本版，请按独立资料保存。";
  textarea().oninput();
  document.activeElement = null;
  item.reason = "Progress refresh";
  await sandbox.render(job);
  assert.equal(textarea().value, "这是 T5000 日本版，请按独立资料保存。");
  // Deliberately clearing a draft must not restore the suggestion on a poll.
  textarea().value = "";
  textarea().oninput();
  item.reason = "Another refresh";
  await sandbox.render(job);
  assert.equal(textarea().value, "");
  textarea().value = "这是新产品 T5000，允许创建目录并维护 Hub 和索引。";
  textarea().oninput();
  await find("Re-Sync →").onclick();
  assert.deepEqual(requests, [
    {
      url: "/api/sync/jobs/job-a/resync?view=summary",
      body: {
        itemId: "file-a",
        feedback: textarea().value,
        forceConvert: false,
      },
    },
  ]);
  assert.equal(item.feedback, "");
  delete item.plan.decision.suggestedFeedback;
  await sandbox.render(job);
  assert.equal(find("Use suggested instructions"), undefined);
  assert.ok(textarea());
  job.kind = "delete";
  await sandbox.render(job);
  assert.equal(find("Reconvert original"), undefined);
  assert.equal(find("Re-Sync →"), undefined);
  assert.ok(find("Instructions for deletion preview"));
  textarea().value = "Only remove the legacy brochure.";
  await find("Regenerate deletion preview →").onclick();
  assert.deepEqual(requests.at(-1).body, {
    itemId: "file-a",
    feedback: textarea().value,
  });
  job.kind = "sync";
  job.status = "awaiting_confirmation";
  item.status = "awaiting_confirmation";
  item.plan.confirmationReason = "DT610 → DT-610.md";
  await sandbox.render(job);
  assert.ok(find("Confirm publication"));
  assert.equal(find("Confirm deletion"), undefined);
  await find("Confirm publication").onclick();
  assert.deepEqual(requests.at(-1), {
    url: "/api/sync/jobs/job-a/confirm?view=summary",
    body: { itemId: "file-a" },
  });
  job.status = "completed";
  item.id = "old-duplicate";
  item.status = "duplicate";
  item.plan = undefined;
  item.matchedSources = [{ path: "i9600/others/release_202610220000/notes.md", coveredProducts: ["i9600"] }];
  await sandbox.render(job);
  assert.ok(find("Verified existing source"));
  assert.ok(find("Current product coverage: i9600"));
  assert.equal(find("Reconvert original"), undefined);
  assert.ok(find("Review product coverage →").disabled);
  textarea().value = "同时适用于 i9600 和 i9600 Mini，请补上遗漏的 Mini 关联。<script>plain text</script>";
  textarea().oninput();
  assert.equal(find("Review product coverage →").disabled, false);
  await find("Review product coverage →").onclick();
  assert.deepEqual(requests.at(-1), {
    url: "/api/sync/jobs/job-a/resync?view=summary",
    body: { itemId: "old-duplicate", feedback: textarea().value, forceConvert: false },
  });
});

test('report diff and coverage fetch only on expansion, survive polling, and release closed bodies', async () => {
  const document={activeElement:null},nodes=new Map(),requests=[];
  document.createElement=tag=>new Element(tag,document);
  document.getElementById=id=>{if(!nodes.has(id))nodes.set(id,new Element('div',document));return nodes.get(id);};
  const sandbox=vm.createContext({document,location:{hash:'',search:''},URLSearchParams,File:class{},fetch:async url=>{
    requests.push(url);return {ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>url.includes('/coverage')?{coverage:['All checked']}:{change:{path:'fixture.md',before:'old',after:'new'}}};
  }});
  const source=await fs.readFile('resources/web/synchronize.js','utf8');
  vm.runInContext(source.slice(0,source.indexOf('async function refresh()'))+'\nglobalThis.render=renderJob;',sandbox);
  const usage={input:0,output:0,requests:0,recorded:0};
  const item={id:'item',name:'fixture.md',status:'published',stage:'Published',textUsage:usage,visualUsage:usage,coverageCount:1,plan:{decision:{products:['RT30'],slot:'accessories'},changes:[{path:'fixture.md',action:'Update',lazy:true,revision:'a'.repeat(64)}]}};
  const job={id:'job',created:'2026-10-23T00:00:00Z',kind:'sync',status:'completed',items:[item]};
  const detail=label=>all(nodes.get('report')).find(n=>n.tagName==='DETAILS'&&n.children[0]?.textContent===label);
  await sandbox.render(job);assert.equal(requests.length,0);
  const diff=detail('Update · fixture.md');diff.open=true;diff.ontoggle();
  await new Promise(r=>setImmediate(r));assert.equal(requests.length,1);assert.match(all(diff).find(n=>n.tagName==='PRE').textContent,/- old\n\+ new/);
  item.stage='Progress changed';await sandbox.render(job);assert.equal(detail('Update · fixture.md'),diff);assert.equal(requests.length,1);
  diff.open=false;diff.ontoggle();assert.equal(all(diff).filter(n=>n.tagName==='PRE').length,0);
  diff.open=true;diff.ontoggle();await new Promise(r=>setImmediate(r));assert.equal(requests.length,2);
  const coverage=detail('Conversion coverage · 1 checks');coverage.open=true;coverage.ontoggle();await new Promise(r=>setImmediate(r));assert.match(all(coverage).find(n=>n.tagName==='PRE').textContent,/All checked/);assert.equal(requests.length,3);
  item.plan.changes[0].revision='b'.repeat(64);await sandbox.render(job);assert.notEqual(detail('Update · fixture.md'),diff);assert.equal(requests.length,3);
});
