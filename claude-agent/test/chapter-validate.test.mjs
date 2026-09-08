// 章节正文的发布前校验。两起真实事故催生的（2026-09-07）：
//   ① 空正文：agent 写好的正文没发布成功，章节页 0 字，book.json 却标着 status:done
//      —— 《好奇心》最后三章、《作天作地》《盘古之白》各最后一章都这样。
//   ② 评审 JSON 当正文发：《读懂你的发动机》第十一章整章正文是
//      {"scores":{...},"verdict":"pass","must_fix":[],"review_round":1}，读者点进去看到一段评审记录。
// build.mjs 原来只数 status === "done"，从不看正文里有没有东西，两种都拦不住。
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkChapterSource } from "../skills/wjs-voicedrop-writing-book/validate.mjs";

const ok = (h) => checkChapterSource(h).ok;
const why = (h) => checkChapterSource(h).reason || "";

test("正常章节放行", () => {
  assert.equal(ok("<p>上一章结尾那张纸上，你写了一个问题：我什么时候能恢复跑步。</p>"), true);
  assert.equal(ok("<h2>刻度尺</h2>\n<p>无氧阈心率 155 是换挡点。</p>"), true);
});

test("绘本一页只有一句话也要放行——阈值不能按科普书的字数定", () => {
  // 绘本每页就几十个字，误伤它等于把整条绘本线卡死。
  assert.equal(ok("<p>嘟嘟看着月亮，想小饼干了。</p>"), true);
  assert.equal(ok("<p>他说：「我在这儿。」</p>"), true);
});

test("空正文拦下（事故①）", () => {
  for (const h of ["", "   ", "\n\n", undefined, null]) {
    assert.equal(ok(h), false, JSON.stringify(h));
  }
  assert.match(why(""), /空/);
});

test("只有标签没有可见文字，也算空", () => {
  assert.equal(ok("<p></p>"), false);
  assert.equal(ok("<p>   </p>\n<div class=\"plain\"><p></p></div>"), false);
  assert.equal(ok("<!-- 待写 -->"), false);
});

test("评审 JSON 当正文发，拦下（事故②，用线上原文）", () => {
  const real = `{
  "scores": {"scores": 5, "novelty": 4, "fun": 4},
  "verdict": "pass",
  "must_fix": [],
  "note": "核实：严格卧床两周VO2max下降约10%+有文献支持。",
  "review_round": 1
}`;
  assert.equal(ok(real), false);
  assert.match(why(real), /JSON|评审/);
  assert.equal(ok('[{"verdict":"pass"}]'), false);
});

test("正文里正常出现花括号或引号，别误判成 JSON", () => {
  // 讲代码/公式的章节会出现 { }，不能因为长得像就拦。
  assert.equal(ok("<p>强化学习里的好奇心奖励写成 r = |f(s) - s'|，代码里是 {reward: intrinsic}。</p>"), true);
  assert.equal(ok('<p>他回了一句「pass」，就没下文了。</p>'), true);
});

test("0 字节文件由 build.mjs 的 readFrag 先拦下，校验只需管「有内容但不是正文」", () => {
  // 冒烟时发现：完全空的文件走不到这里——readFrag 读出空串即报「缺 chapters/NN.html」
  // 并退出。所以本模块真正独有的价值是下面两类「文件非空、内容却不是正文」。
  assert.equal(ok("<p></p>"), false);          // 有标签、无文字
  assert.equal(ok('{"verdict":"pass"}'), false); // 非空，但是 JSON
});
