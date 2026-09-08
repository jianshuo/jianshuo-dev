// 章节正文的发布前校验 —— build.mjs 发任何一章之前都要过这一关。
//
// 2026-09-07 一天里踩到两种「发出去了但读者看到的是空气」：
//   ① 正文写好了、评审也过了，但发布那一步断在半路：章节页 0 字，而 book.json
//      里 status 已经写成 done。《好奇心》最后三章、《作天作地》和《盘古之白》
//      的最后一章都是这样，从书架和 status 上完全看不出来。
//   ② 独立评审返回的 JSON 被当成正文写进了 chapters/NN.html：《读懂你的发动机》
//      第十一章整章就是 {"scores":…,"verdict":"pass","review_round":1}。
// build.mjs 原来只统计 status === "done"，从不看正文里到底有没有东西，两种都放行。
//
// 阈值刻意定得极低（可见文字 > 0 即可），因为绘本一页就几十个字——按科普书的
// 篇幅设门槛会把整条绘本线卡死。这里只拦「明显不是正文」的东西，不做质量判断。

/** 去掉标签/注释/实体，取出读者真正能看到的文字。 */
function visibleText(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, "")           // HTML 注释不算正文（「<!-- 待写 -->」）
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;|&#\d+;/gi, "")          // &nbsp; 这类空白实体不算可见文字
    .replace(/\s+/g, "")
    .trim();
}

/** 整段正文其实是一个 JSON 文档？（评审回执漏进正文的形态） */
function looksLikeJsonDocument(html) {
  const s = String(html).trim();
  // 必须整体就是一个 JSON 值——正文里出现 { } 或引号不算（讲代码的章节很常见）。
  if (!(s.startsWith("{") && s.endsWith("}")) && !(s.startsWith("[") && s.endsWith("]"))) return false;
  try { JSON.parse(s); return true; } catch { return false; }
}

/**
 * @param {string} html 章节正文的 HTML 片段（chapters/NN.html 的内容）
 * @returns {{ok: boolean, reason?: string}}
 */
export function checkChapterSource(html) {
  if (html === undefined || html === null) return { ok: false, reason: "正文为空（文件不存在或读不出内容）" };
  if (looksLikeJsonDocument(html)) {
    return { ok: false, reason: "正文整段是一个 JSON 文档——多半是把评审回执写进了正文，不是章节内容" };
  }
  if (!visibleText(html)) {
    return { ok: false, reason: "正文为空：去掉标签后没有任何可见文字" };
  }
  return { ok: true };
}
