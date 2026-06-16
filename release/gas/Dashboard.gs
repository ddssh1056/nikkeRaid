  /**
  * 유레 시각화 대시보드 백엔드 (섹션 2: 실시간 전황/개요 + 보스 상세)
  *
  * 멀티 유니온 설계: 공유 데이터(보스 HP/약점/이미지=boss.json, 난이도계수=coef.json, 캐릭 이미지/매핑)는
  *                  제작자 GitHub에서 가져오고, 각 유니온은 자기 RawData만 있으면 동작.
  *
  * 핵심 규칙(사용자 피드백 반영):
  *  - 집계는 '하드 레이드(Difficulty=2)' 기록만 사용. 노멀(1일차 올클)은 제외.
  *  - 보스 속성 칩은 '약점'(=써야 할 속성)을 표시. element_id(보스 자체 속성)에서 파생.
  *  - 보스 상세 산점도 X축은 '싱크로 레벨'(보스 레벨은 딜에 미미 → 무시).
  *  - 보스 정보표는 transposed(보스=열): 이미지 / 잔여·최대HP / 난이도계수.
  *  - 난이도계수 출처 3종: auto(시즌 자동계산) / manual(수동 입력) / github(제작자 coef.json).
  */

  // ===== 설정 (제작자 공유 소스) =====
  // ⚠️ 캐시 코드버전: 개요/모의전/분석 **출력 구조를 바꾸면 이 값을 +1** → 캐시 키가 바뀌어 옛 캐시 자동 무효화.
  //    → 배포 후 `?action=flush` 안 해도 됨(옛 결과가 새 코드 결과로 자동 교체). 외부데이터(_Cache)는 별개(필요 시 flush).
  var CODE_VER = '17';   // 분석 차수추이에 멤버×보스 딜(bossDmg)+시즌별 보스메타(bossMeta) 추가 → 출력 구조 변경
  var SERVER_BUILD = '2026-06-18b round17-live-season-replace (doPost 진행중 차수 전체교체로 공격순서 보존; limitN 진행단서 정렬)';
  var GH_IMG_BASE   = 'https://cdn.jsdelivr.net/gh/ddssh1056/nikkeRaid@main/imgSource/';        // 캐릭 이미지
  var BOSS_IMG_BASE = 'https://cdn.jsdelivr.net/gh/ddssh1056/nikkeRaid@main/bossImgSource/';     // 보스 이미지
  var GH_DATA_BASE  = 'https://cdn.jsdelivr.net/gh/ddssh1056/nikkeRaid@main/';                   // boss.json / coef.json
  var ROSTER_URL    = 'https://sg-tools-cdn.blablalink.com/wi-97/ni-77/ffc69c4074f27bc772acbe869127e616.json';
  var SHEET_DATABOS = 'dataBos';        // GitHub 실패 시 폴백
  var SHEET_OVERRIDES = 'Overrides';    // 오버딜 수동
  var SHEET_COEF      = 'CoefOverrides';// 난이도계수 수동

  // ===== 영속 캐시(시트 기반) =====
  //  _Cache(소형): 외부 GitHub 데이터(boss/coef/resmap/dataNik) 원문 + FetchedAt. 6h 지났을 때만 재요청.
  //  _OvCache(대형): 시즌 개요 집계 결과를 JSON으로 청크 저장. Sig(=rawSig|ovVer) 일치 시 재집계 없이 즉시 반환.
  var SIX_H = 6 * 3600 * 1000;
  var SHEET_CACHE = '_Cache';
  var SHEET_OVCACHE = '_OvCache';
  var SHEET_TREND = '_TrendCache';   // 분석탭용 압축 요약(시즌별 멤버 지표만) — 전체 개요 12개 재구성 회피
  var SHEET_LAST_ROSTER = 'LastRoster';
  var _extMemo = null;   // 한 실행 내 _Cache 반복 읽기 방지

  function cacheSheet_(name, cols) {
    var ss = SpreadsheetApp.getActiveSpreadsheet(), sh = ss.getSheetByName(name);
    if (!sh) { sh = ss.insertSheet(name); sh.getRange(1, 1, 1, cols.length).setValues([cols]); sh.setFrozenRows(1); try { sh.hideSheet(); } catch (e) {} }
    return sh;
  }
  function extCacheAll_() {
    if (_extMemo) return _extMemo;
    var out = {};
    try {
      var sh = cacheSheet_(SHEET_CACHE, ['Key', 'Value', 'FetchedAt']);
      if (sh.getLastRow() >= 2) { var v = sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues(); for (var i = 0; i < v.length; i++) if (v[i][0] !== '') out[String(v[i][0])] = { row: i + 2, value: v[i][1], at: v[i][2] }; }
    } catch (e) {}
    _extMemo = out; return out;
  }
  // 외부 GitHub 데이터: 6h 시트 캐시. 만료/없을 때만 UrlFetch. 실패 시 옛 값이라도 반환.
  function cachedExternal_(file, url, maxAgeMs) {
    var key = 'gh:' + file;
    try {
      var all = extCacheAll_(), e = all[key];
      if (e && e.at instanceof Date && (Date.now() - e.at.getTime()) < maxAgeMs && e.value) return e.value;
      var txt = '';
      try { txt = UrlFetchApp.fetch(url, { muteHttpExceptions: true }).getContentText(); } catch (ex) { txt = ''; }
      if (txt) {
        var sh = cacheSheet_(SHEET_CACHE, ['Key', 'Value', 'FetchedAt']);
        if (e) sh.getRange(e.row, 1, 1, 3).setValues([[key, txt, new Date()]]);
        else sh.getRange(sh.getLastRow() + 1, 1, 1, 3).setValues([[key, txt, new Date()]]);
        _extMemo = null;
        return txt;
      }
      return e ? e.value : '';
    } catch (e2) {
      try { return UrlFetchApp.fetch(url, { muteHttpExceptions: true }).getContentText(); } catch (e3) { return ''; }
    }
  }
  // 시즌 개요 영속 캐시(압축 b64 문자열을 청크 저장). 셀당 5만자 제한 회피 위해 45000자 분할.
  function ovCacheGet_(prefix, sig) {
    try {
      var sh = cacheSheet_(SHEET_OVCACHE, ['Key', 'Value', 'FetchedAt', 'Sig']);
      if (sh.getLastRow() < 2) return null;
      var v = sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues(), header = null, chunks = {};
      for (var i = 0; i < v.length; i++) { var k = String(v[i][0]); if (k === prefix) header = v[i]; else if (k.indexOf(prefix + ':') === 0) chunks[k] = v[i][1]; }
      if (!header || String(header[3]) !== String(sig)) return null;   // 데이터 변경 → 미스
      var n = Number(header[1]) || 0, s = '';
      for (var c = 0; c < n; c++) { var ck = chunks[prefix + ':' + c]; if (ck == null) return null; s += ck; }
      return s;   // 압축 b64 문자열
    } catch (e) { return null; }
  }
  function ovCachePut_(prefix, sig, jsonStr) {
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(5000);
      var sh = cacheSheet_(SHEET_OVCACHE, ['Key', 'Value', 'FetchedAt', 'Sig']);
      var all = sh.getLastRow() >= 2 ? sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues() : [];
      var kept = all.filter(function (r) { return r[0] !== '' && String(r[0]) !== prefix && String(r[0]).indexOf(prefix + ':') !== 0; });
      var size = 45000, n = Math.ceil(jsonStr.length / size), add = [[prefix, String(n), new Date(), String(sig)]];
      for (var c = 0; c < n; c++) add.push([prefix + ':' + c, jsonStr.substr(c * size, size), new Date(), String(sig)]);
      var rows = kept.concat(add);
      if (sh.getLastRow() >= 2) sh.getRange(2, 1, sh.getLastRow() - 1, 4).clearContent();
      if (rows.length) sh.getRange(2, 1, rows.length, 4).setValues(rows);
    } catch (e) {} finally { try { lock.releaseLock(); } catch (e2) {} }
  }

  // ===== 속성 / 약점 모델 =====
  // element_id 앞자리 → 보스 '자체' 속성 (API가 주는 값). 1화 2수 3풍 4전 5철.
  function ownElement_(code) {
    var d = String(code || '').charAt(0);
    return ({ '1': '작열', '2': '수냉', '3': '풍압', '4': '전격', '5': '철갑' })[d] || '';
  }
  // 약점 = 그 속성을 이기는 상성(써야 할 속성). 작열←수냉, 수냉←전격, 풍압←작열, 전격←철갑, 철갑←풍압.
  function weaknessOf_(own) {
    return ({ '작열': '수냉', '수냉': '전격', '풍압': '작열', '전격': '철갑', '철갑': '풍압' })[own] || '';
  }
  function elemColor_(name) {
    return ({ '작열': '#e8503a', '수냉': '#3a8fe8', '풍압': '#3ac06b', '전격': '#9b59e8', '철갑': '#e8b73a' })[name] || '#888888';
  }

  // ===== 라우터 =====
  function doGet(e) {
    var p = (e && e.parameter) || {};
    if (p.action === 'charmap') return charMapOutput_();
    if (p.action === 'alive') return jsonOut_({ ok: true, msg: 'dashboard alive' });
    if (p.action === 'flush') { try { flushCache(); } catch (e2) {} return jsonOut_({ ok: true, flushed: true }); }   // flushCache로 위임(전역 flush epoch까지 +1)
    if (p.action === 'warm') { var tw = Date.now(); try { warmAll_(); } catch (e) {} return jsonOut_({ ok: true, warmed: true, ms: Date.now() - tw }); }   // 캐시 즉시 워밍(+소요 ms)
    if (p.action === 'setupwarm') { try { return jsonOut_({ ok: true, msg: setupWarm() }); } catch (e) { return jsonOut_({ ok: false, error: String(e), hint: '기본 배포본은 최소 권한이라 시간 트리거 권한(script.scriptapp)을 포함하지 않습니다. 꼭 필요할 때만 appsscript.json에 해당 scope를 추가하세요.' }); } }   // 선택 기능: 5분 트리거 설치
    if (p.action === 'diag') return jsonOut_(diag_());
    if (p.action === 'trends') {                                        // 분석탭 풀 진단: RawData 상태 + 차수 + 시즌별 집계
      var dg = { ok: true };
      try {
        var dsh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RAW);
        dg.rawSheetFound = !!dsh;
        dg.rawLastRow = dsh ? dsh.getLastRow() : -1;
        dg.rawLastCol = dsh ? dsh.getLastColumn() : -1;
        dg.header = dsh && dsh.getLastRow() >= 1 ? dsh.getRange(1, 1, 1, dsh.getLastColumn()).getValues()[0] : [];
        dg.seasons = getSeasons().seasons;
        dg.perSeason = (dg.seasons || []).slice(0, 12).map(function (s) {
          var r = { season: s };
          try { var ov = computeOverview_(s, 'auto'); r.ok = !!(ov && ov.ok); r.members = (ov && ov.members) ? ov.members.length : 0; r.hardHits = (ov && ov.meta) ? ov.meta.totalHits : 0; if (ov && !ov.ok) r.error = ov.error; }
          catch (e) { r.thrown = String(e); }
          return r;
        });
        dg.trends = getMemberTrends('auto', 0);
      } catch (e) { dg.err = String(e); }
      return jsonOut_(dg);
    }
    var t = HtmlService.createTemplateFromFile('index');
    t.page = p.page || 'overview';
    t.season = p.season || '';
    t.adminReq = (typeof ADMIN_KEY !== 'undefined' && ADMIN_KEY) ? '1' : '';   // 운영자 키 설정 시 옵션 탭을 일반 유저에게 숨김
    // 부트스트랩 데이터를 HTML에 **인라인** → 첫 화면(개요) 렌더에 google.script.run 왕복 0회.
    //  ov는 gz압축 b64(작음, base64라 </script> 위험 없음). pako는 head에서 동기 로드돼 클라가 바로 해제.
    //  실패하면 'null' → 클라가 기존 round-trip 폴백.
    try { t.boot = JSON.stringify(getBootstrap(p.season || 0, 'auto', 1)).replace(/</g, '\\u003c'); }
    catch (eB) { t.boot = 'null'; }
    return t.evaluate().setTitle('유레 대시보드')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
  function include(name) { return HtmlService.createHtmlOutputFromFile(name).getContent(); }

  // ⚠️ 외부요청(UrlFetchApp) 권한 부여용. GAS 편집기에서 이 함수를 한 번 [실행]해 권한 동의창에서
  //    '외부 서비스에 연결' 을 허용한 뒤, 웹앱을 '새 버전'으로 재배포해야 이미지/보스HP가 뜬다.
  function forceAuth() {
    var r = UrlFetchApp.fetch(GH_DATA_BASE + 'resmap.json', { muteHttpExceptions: true });
    SpreadsheetApp.getActiveSpreadsheet().getName();
    return r.getResponseCode();
  }

  // 진단: …/exec?action=diag 로 열어 서버측 데이터 상태 확인(이미지 안 뜰 때)
  function diag_() {
    var out = { ok: true, bossImgBase: BOSS_IMG_BASE, imgBase: GH_IMG_BASE, dataBase: GH_DATA_BASE };
    try { var bj = JSON.parse(UrlFetchApp.fetch(GH_DATA_BASE + 'boss.json', { muteHttpExceptions: true }).getContentText()); out.bossJson40_0 = (bj['40'] || [])[0]; } catch (e) { out.bossJsonErr = String(e); }
    try { var rm = rosterResourceMap_(); out.resmapCount = Object.keys(rm).length; out.resmap4513 = rm['4513']; } catch (e) { out.resmapErr = String(e); }
    out.sampleCharImg = GH_IMG_BASE + 'si_c' + ('000' + (out.resmap4513 || 513)).slice(-3) + '_00_s.png';
    out.sampleBossImg = BOSS_IMG_BASE + encodeURIComponent('Enemy_Mace.webp');
    return out;
  }

  // ===== RawData 로드 =====
  //  ⚠️ 한 실행(요청) 내 반복 파싱 방지 메모. 분석탭(getMemberTrends)이 시즌별로 getOverview를 최대 12번 부르는데,
  //     캐시 미스면 매번 전체 시트를 다시 읽던 것을 1회로 줄임. RawData는 읽기 실행 중 안 바뀌므로 안전(쓰기는 doPost=별도 실행).
  var _rawMemo = null;
  function loadRawData_() {
    if (_rawMemo) return _rawMemo;
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(SHEET_RAW);
    if (!sh || sh.getLastRow() < 2) return (_rawMemo = []);
    var vals = sh.getDataRange().getValues();
    var head = vals[0], idx = {};
    for (var i = 0; i < head.length; i++) idx[head[i]] = i;
    var out = [];
    for (var r = 1; r < vals.length; r++) {
      var row = vals[r];
      if (row[idx.Season] === '' || row[idx.Season] == null) continue;
      out.push({
        season: Number(row[idx.Season]), day: Number(row[idx.Day]), step: Number(row[idx.Step]),
        difficulty: Number(row[idx.Difficulty]), boss: row[idx.Boss], element: String(row[idx.Element]),
        nickname: row[idx.Nickname], openid: String(row[idx.Openid]), syncLv: Number(row[idx.SyncLv]) || 0,
        totalDamage: Number(row[idx.TotalDamage]) || 0,
        isFinalHit: row[idx.IsFinalHit] === true || row[idx.IsFinalHit] === 'TRUE' || row[idx.IsFinalHit] === 1,
        level: Number(row[idx.Level]) || 0, iconId: String(row[idx.IconId] || ''), squadRaw: row[idx.SquadRaw],
        chars: [row[idx.Char1], row[idx.Char2], row[idx.Char3], row[idx.Char4], row[idx.Char5]],
        breaks: [row[idx.Break1], row[idx.Break2], row[idx.Break3], row[idx.Break4], row[idx.Break5]]
      });
    }
    return (_rawMemo = out);
  }
  // 하드 레이드만(노멀=1일차 올클 제외). 사용자 피드백 #1.
  function hardOf_(season) {
    return loadRawData_().filter(function (r) { return r.season === Number(season) && r.difficulty === 2; });
  }
  // 분석 전용 경량 로더: 지표에 필요한 앞쪽 컬럼만 읽음(큰 SquadRaw[30열]·Char/Break 제외) → 콜드 분석 I/O 대폭 축소.
  //  ⚠️ 전체가 이미 읽힌 실행(_rawMemo)이면 그대로 재사용(같은 필드 포함). 분석은 보통 단독 실행이라 경량 읽기로 빠짐.
  var _trendRowsMemo = null;
  function loadTrendRows_() {
    if (_trendRowsMemo) return _trendRowsMemo;
    if (_rawMemo) return (_trendRowsMemo = _rawMemo);
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RAW);
    if (!sh || sh.getLastRow() < 2) return (_trendRowsMemo = []);
    var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0], idx = {};
    for (var i = 0; i < head.length; i++) idx[head[i]] = i;
    var need = ['Season', 'Difficulty', 'Boss', 'Step', 'Nickname', 'Openid', 'SyncLv', 'TotalDamage', 'IsFinalHit'];
    var maxCol = 0; need.forEach(function (k) { if (idx[k] != null && idx[k] + 1 > maxCol) maxCol = idx[k] + 1; });
    if (!maxCol) maxCol = sh.getLastColumn();   // 헤더 못 찾으면 안전하게 전체
    var n = sh.getLastRow() - 1, vals = sh.getRange(2, 1, n, maxCol).getValues(), out = [];
    for (var r = 0; r < vals.length; r++) {
      var row = vals[r]; if (row[idx.Season] === '' || row[idx.Season] == null) continue;
      out.push({ season: Number(row[idx.Season]), difficulty: Number(row[idx.Difficulty]), boss: row[idx.Boss], step: Number(row[idx.Step]),
        nickname: row[idx.Nickname], openid: String(row[idx.Openid]), syncLv: Number(row[idx.SyncLv]) || 0,
        totalDamage: Number(row[idx.TotalDamage]) || 0,
        isFinalHit: row[idx.IsFinalHit] === true || row[idx.IsFinalHit] === 'TRUE' || row[idx.IsFinalHit] === 1 });
    }
    return (_trendRowsMemo = out);
  }
  function hardTrendRows_(season) {
    return loadTrendRows_().filter(function (r) { return r.season === Number(season) && r.difficulty === 2; });
  }

  // ===== 캐릭 resource_id 맵 (tid prefix → resource_id), 클라가 이미지 URL 생성 =====
  function rosterResourceMap_() {
    var map = {};
    // 1) GitHub resmap.json (6h 시트 캐시). 키=floor(tid/100), 값=resource_id.
    try {
      var txt = cachedExternal_('resmap.json', GH_DATA_BASE + 'resmap.json', SIX_H);
      var g = txt ? JSON.parse(txt) : null;
      if (g && typeof g === 'object') Object.keys(g).forEach(function (k) { map[k] = g[k]; });
    } catch (e) {}
    // 2) 폴백: blablalink 로스터(휘발성 해시 URL — GAS 서버가 못 받을 수 있음)
    if (!Object.keys(map).length) {
      try {
        var list = JSON.parse(UrlFetchApp.fetch(ROSTER_URL, { muteHttpExceptions: true }).getContentText());
        if (Array.isArray(list)) list.forEach(function (it) {
          if (it && it.id != null && it.resource_id != null) map[Math.floor(it.id / 100)] = it.resource_id;
        });
      } catch (e) {}
    }
    return map;
  }
  function squadOf_(h) {   // 페이로드 경량: 화면에 쓰는 tid/lv/이름/돌파만(slot·combat 제외)
    var sq = [];
    try { sq = JSON.parse(h.squadRaw || '[]'); } catch (e) {}
    return sq.map(function (c) {
      return { tid: c.tid, lv: c.lv, name: (h.chars[c.slot - 1] || ''), brk: (h.breaks[c.slot - 1] || '') };
    });
  }
  // 응답 압축(gzip→base64). 큰 JSON 전송량 대폭 감소. 클라가 pako 지원할 때(gz=true)만 압축.
  function gzipB64_(js) { return Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(js, 'application/json')).getBytes()); }
  function b64ToObj_(b64) { try { return JSON.parse(Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(b64))).getDataAsString('UTF-8')); } catch (e) { return null; } }
  function packResult_(obj, gz) {
    if (!gz) return obj;   // 클라가 압축 해제 불가 → 원본 그대로(안전)
    try { var js = JSON.stringify(obj); if (js.length < 20000) return obj; return { __gz: gzipB64_(js) }; } catch (e) { return obj; }
  }

  // ===== 로딩 타이밍 계측 =====
  //  각 엔드포인트가 구간별 소요(ms)를 응답의 _t에 실어 보냄 → 클라가 브라우저 콘솔에 round-trip과 함께 출력.
  //  _t는 gz 압축 바깥(또는 원본 객체)에 붙어 unpack 전에 읽힘. 캐시 blob에는 들어가지 않음(압축/저장 후에 붙이므로).
  function Timer_() {
    var t0 = Date.now(), last = t0, marks = [];
    return {
      mark: function (label) { var n = Date.now(); marks.push([label, n - last]); last = n; },
      done: function (hit) { var o = { build: SERVER_BUILD, total: Date.now() - t0, marks: marks }; if (hit) o.hit = hit; return o; }
    };
  }
  function withTiming_(out, T, hit) { try { if (out && typeof out === 'object') out._t = T.done(hit); } catch (e) {} return out; }

  // ===== 보스 메타(HP/약점/이미지): GitHub boss.json → 실패 시 로컬 dataBos =====
  function fetchBossData_(season) {
    var res = { byName: {}, byStep: {} };
    try {
      var txt = cachedExternal_('boss.json', GH_DATA_BASE + 'boss.json', SIX_H);
      var all = txt ? JSON.parse(txt) : {};
      (all[String(season)] || []).forEach(function (b) {
        var meta = { hp: b.hp || [], step: b.step, name: b.name, weak: b.weak || '', img: b.img || '' };
        if (b.name) res.byName[b.name] = meta;
        if (b.step) res.byStep[b.step] = meta;
      });
    } catch (e) {}
    if (!Object.keys(res.byStep).length) {
      var hp = parseDataBos_(season);
      for (var s in hp) res.byStep[s] = { hp: [hp[s][1] || 0, hp[s][2] || 0, hp[s][3] || 0], weak: '', img: '' };
    }
    overlayApiHp_(season, res);   // 수집기가 관측한 실제 단계HP(BossLevels)를 boss.json 위에 우선 적용
    return res;
  }
  // BossLevels 시트(수집기 GetUnionRaidLevelInfo 관측치: 시즌·난이도·보스·단계별 '단독' MaxHp)를
  // boss.json의 '누적' hp 배열에 우선 병합. 관측된 단계는 API값, 미관측 단계는 기존값 유지.
  // 관측이 기존 배열보다 깊으면 연장(4단계+). 중간에 값 없는 단계가 생기면 누적 왜곡 방지를 위해 거기서 중단.
  // 하드(Difficulty=2)만 사용(집계 규칙과 동일). boss.json에 없는 보스명은 byName 전용 메타로 추가(step 미상).
  function overlayApiHp_(season, res) {
    try {
      var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('BossLevels');
      if (!sh || sh.getLastRow() < 2) return;
      var v = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues(); // Season,Difficulty,Boss,Level,MaxHp
      var byBoss = {}; // 보스명 -> { level: 단독 maxHp }
      v.forEach(function (r) {
        if (Number(r[0]) !== Number(season) || Number(r[1]) !== 2) return;
        var name = String(r[2] || '').trim();
        if (!name) return;
        (byBoss[name] = byBoss[name] || {})[Number(r[3])] = Number(r[4]) || 0;
      });
      Object.keys(byBoss).forEach(function (name) {
        var meta = res.byName[name];
        if (!meta) { meta = { hp: [], step: '', name: name, weak: '', img: '' }; res.byName[name] = meta; }
        var cum = meta.hp || [], standalone = [];
        for (var i = 0; i < cum.length; i++) standalone[i] = (Number(cum[i]) || 0) - (i ? Number(cum[i - 1]) || 0 : 0);
        var obs = byBoss[name], maxLv = standalone.length;
        Object.keys(obs).forEach(function (L) { if (Number(L) > maxLv) maxLv = Number(L); });
        var merged = [], run = 0;
        for (var L = 1; L <= maxLv; L++) {
          var solo = obs[L] || standalone[L - 1] || 0;
          if (!solo) break;
          run += solo; merged.push(run);
        }
        if (merged.length) meta.hp = merged;
      });
    } catch (e) {}
  }
  function parseDataBos_(season) {
    var hp = {};
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_DATABOS);
    if (!sh || sh.getLastRow() < 3) return hp;
    var v = sh.getDataRange().getValues(), col = -1;
    for (var c = 0; c < v[1].length; c++) if (Number(v[1][c]) === Number(season)) { col = c; break; }
    if (col < 0) return hp;
    for (var r = 2; r <= 16 && r < v.length; r++) {
      var a = Number(v[r][0]), phase = Number(v[r][2]), val = Number(String(v[r][col]).replace(/,/g, ''));
      if (!a || !phase || !val) continue;
      var step = ((a - 1) % 5) + 1;
      hp[step] = hp[step] || {}; hp[step][phase] = val;
    }
    return hp;
  }
  // 누적딜이 현재 어느 단계인지 + 그 단계의 잔여/최대 HP. 실시간 진행 표기용.
  //  ⚠️ hpCum=[1단계누적, 1+2단계누적, 1+2+3단계누적] (dataBos/boss.json은 누적값으로 기록됨!).
  //  그 단계 단독 최대 = top - prev. 모든 단계 소진 시 마지막 단계 0/최대로 고정(레이드 종료 = Lv.3 0/3단계단독).
  function phaseProgress_(hpCum, dmg) {
    hpCum = hpCum || []; dmg = Number(dmg) || 0;
    var prev = 0;
    for (var i = 0; i < hpCum.length; i++) {
      var top = Number(hpCum[i]) || 0;                 // 이 단계 끝까지의 누적 HP 경계
      if (dmg < top) return { phase: i + 1, remain: top - dmg, max: top - prev };  // remain=그 단계 잔여, max=그 단계 단독 HP
      prev = top;
    }
    var last = Number(hpCum[hpCum.length - 1]) || 0;
    var prev2 = hpCum.length >= 2 ? (Number(hpCum[hpCum.length - 2]) || 0) : 0;
    return { phase: hpCum.length || 1, remain: 0, max: last - prev2 };
  }

  // ===== 난이도계수: 제작자 coef.json(차수→step→계수) =====
  function fetchCoefJson_(season) {
    var out = {};
    try {
      var txt = cachedExternal_('coef.json', GH_DATA_BASE + 'coef.json', SIX_H);
      var all = txt ? JSON.parse(txt) : {};
      var s = all[String(season)] || {};
      Object.keys(s).forEach(function (k) { out[Number(k)] = Number(s[k]); });
    } catch (e) {}
    return out;
  }
  // 난이도계수 수동(CoefOverrides 시트): Season, Boss, Step, Coef(비율), UpdatedAt
  function loadCoefOverrides_(season) {
    var out = { byName: {}, byStep: {} };
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_COEF);
    if (sh && sh.getLastRow() >= 2) {
      sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues().forEach(function (r) {
        if (Number(r[0]) !== Number(season)) return;
        var boss = String(r[1]), step = Number(r[2]), coef = Number(r[3]);
        if (boss) out.byName[boss] = coef;
        if (step) out.byStep[step] = coef;
      });
    }
    return out;
  }
  function rebuildSeasonMode_(season, coefMode) {
    var ov = getOverview(season, coefMode, false, true);
    try { seasonTrend_(season, coefMode, null, ov && ov.ok ? ov : null); } catch (e) {}
    return ov;
  }
  // 수동 계수 전체를 한 번에 저장하고 manual 뷰만 write-through 재생성한다.
  // ===== 운영자 권한(옵션 잠금) =====
  // ADMIN_KEY(Code.gs)가 설정돼 있으면 옵션 쓰기 RPC는 일치하는 키를 받아야 한다. 비어 있으면 누구나 허용(종전).
  function verifyAdminKey(key) {
    var req = (typeof ADMIN_KEY !== 'undefined' && ADMIN_KEY) ? true : false;
    return { ok: true, required: req, valid: (!req || String(key) === String(ADMIN_KEY)) };
  }
  function requireAdmin_(key) {
    if (typeof ADMIN_KEY !== 'undefined' && ADMIN_KEY && String(key) !== String(ADMIN_KEY)) {
      throw new Error('운영자 권한이 필요합니다. 헤더의 "🔒 운영자" 버튼에서 운영자 키를 입력하세요.');
    }
  }

  function saveCoefOverrides(season, json, gz, adminKey) {
    requireAdmin_(adminKey);
    var T = Timer_();
    season = Number(season);
    var list = []; try { list = JSON.parse(json || '[]') || []; } catch (e) {}
    list = list.map(function (x) {
      return { boss: String(x.boss || ''), step: Number(x.step) || '', coef: Number(x.coef) || 0 };
    }).filter(function (x) { return x.boss; });
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
      var ss = SpreadsheetApp.getActiveSpreadsheet(), sh = ss.getSheetByName(SHEET_COEF);
      if (!sh) { sh = ss.insertSheet(SHEET_COEF); sh.getRange(1, 1, 1, 5).setValues([['Season', 'Boss', 'Step', 'Coef', 'UpdatedAt']]); sh.setFrozenRows(1); }
      var rows = sh.getLastRow() >= 2 ? sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues() : [];
      var byKey = {};
      rows.forEach(function (r, i) { byKey[Number(r[0]) + '|' + String(r[1])] = i; });
      var now = new Date();
      list.forEach(function (x) {
        var row = [season, x.boss, x.step, x.coef, now], key = season + '|' + x.boss;
        if (byKey[key] != null) rows[byKey[key]] = row;
        else { byKey[key] = rows.length; rows.push(row); }
      });
      if (sh.getLastRow() >= 2) sh.getRange(2, 1, sh.getLastRow() - 1, 5).clearContent();
      if (rows.length) sh.getRange(2, 1, rows.length, 5).setValues(rows);
      bumpCoefVer_(season);
      SpreadsheetApp.flush();
    } finally {
      try { lock.releaseLock(); } catch (e2) {}
    }
    T.mark('save');
    var ov = rebuildSeasonMode_(season, 'manual');
    T.mark('rebuild');
    var analysis = null;
    try { analysis = getMemberTrends('manual', false); } catch (e3) {}
    T.mark('analysis');
    var packed = packResult_({ ok: true, count: list.length, overview: ov, analysis: analysis }, gz);
    T.mark('pack');
    return withTiming_(packed, T);
  }
  // 이전 배포 탭 호환용 단건 API.
  function saveCoefOverride(season, boss, step, coef) {
    return saveCoefOverrides(season, JSON.stringify([{ boss: boss, step: step, coef: coef }]), false);
  }
  // 난이도계수 표(옵션 화면): 전 차수의 auto/manual/github 계수를 **한 콜**로 반환 → 차수 전환마다 재로딩/재계산 안 함.
  //  auto=캐시된 개요(차수 끝나면 불변이라 시트 영속 캐시에서 즉시), manual=CoefOverrides 시트, github=coef.json. 값=비율(0.xx).
  function getCoefTable(gz) {
    var T = Timer_();
    var seasons = (getSeasons().seasons || []).map(Number).sort(function (a, b) { return b - a; });   // 최신이 위
    var out = [];
    seasons.forEach(function (s) {
      var ov = null;
      try { ov = getOverview(s, 'auto', 0, false); } catch (e) {}   // gz=0=원본객체, persist=false=뷰어경로(시트쓰기 없음·캐시 우선)
      if (!ov || !ov.ok) return;
      var man = {}; try { man = loadCoefOverrides_(s).byName || {}; } catch (e) {}
      var gh = {}; try { gh = fetchCoefJson_(s) || {}; } catch (e) {}   // step -> 비율
      out.push({
        season: s,
        bosses: (ov.bosses || []).map(function (b) {
          return {
            name: b.name, step: b.step, weak: b.weak, weakColor: b.weakColor,
            auto: (b.coefAuto != null ? b.coefAuto : b.coef),
            manual: (man[b.name] != null ? man[b.name] : null),
            github: (gh[b.step] != null ? gh[b.step] : null)
          };
        })
      });
    });
    T.mark('coefTable');
    return withTiming_(packResult_({ ok: true, seasons: out }, gz), T);
  }



  // ===== Overrides (오버딜 수동) =====
  // 실행 내 메모(분석 콜드가 시즌마다 호출 → Overrides 시트 6번 읽던 것을 1회로). 저장 시 _ovrMemo=null로 갱신.
  var _ovrMemo = null;
  function loadOverrides_(season) {
    if (!_ovrMemo) {
      _ovrMemo = [];
      var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_OVERRIDES);
      if (sh && sh.getLastRow() >= 2) {
        sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues().forEach(function (r) {
          _ovrMemo.push({ season: Number(r[0]), boss: String(r[1]), nickname: String(r[2]), overdamage: Number(r[3]) || 0 });
        });
      }
    }
    return _ovrMemo.filter(function (o) { return o.season === Number(season); });
  }
  function saveOverride(season, boss, nickname, overdamage, coefMode, gz) {
    var T = Timer_();
    season = Number(season);
    boss = String(boss);
    nickname = String(nickname);
    coefMode = coefMode || 'auto';
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
      var ss = SpreadsheetApp.getActiveSpreadsheet(), sh = ss.getSheetByName(SHEET_OVERRIDES);
      if (!sh) { sh = ss.insertSheet(SHEET_OVERRIDES); sh.getRange(1, 1, 1, 5).setValues([['Season', 'Boss', 'Nickname', 'Overdamage', 'UpdatedAt']]); sh.setFrozenRows(1); }
      var last = sh.getLastRow(), found = -1;
      if (last >= 2) {
        var v = sh.getRange(2, 1, last - 1, 3).getValues();
        for (var i = 0; i < v.length; i++) if (Number(v[i][0]) === season && String(v[i][1]) === boss && String(v[i][2]) === nickname) { found = i + 2; break; }
      }
      var rowv = [season, boss, nickname, Number(overdamage) || 0, new Date()];
      if (found > 0) sh.getRange(found, 1, 1, 5).setValues([rowv]); else sh.getRange(sh.getLastRow() + 1, 1, 1, 5).setValues([rowv]);
      _ovrMemo = null;
      bumpOvVer_(season);
      SpreadsheetApp.flush();
    } finally {
      try { lock.releaseLock(); } catch (e2) {}
    }
    T.mark('save');
    var ov = rebuildSeasonMode_(season, coefMode);
    T.mark('current');
    var autoOv = null;
    if (coefMode !== 'auto') {
      try { autoOv = rebuildSeasonMode_(season, 'auto'); } catch (e3) {}
    }
    T.mark('auto');
    var bd = null;
    try { bd = getBossDetail(season, boss, false); } catch (e4) {}
    T.mark('boss');
    var analysis = null;
    try { analysis = getMemberTrends(coefMode, false); } catch (e5) {}
    T.mark('analysis');
    var packed = packResult_({ ok: true, overview: ov, autoOverview: autoOv, bossDetail: bd, analysis: analysis }, gz);
    T.mark('pack');
    return withTiming_(packed, T);
  }

  // ===== 회귀 y=a·x^b =====
  function regressPower_(pts) {
    var xs = [], ys = [];
    pts.forEach(function (p) { if (p.x > 0 && p.y > 0) { xs.push(Math.log(p.x)); ys.push(Math.log(p.y)); } });
    var n = xs.length; if (n < 2) return null;
    var sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (var i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
    var d = n * sxx - sx * sx; if (d === 0) return null;
    var b = (n * sxy - sx * sy) / d;
    return { a: Math.exp((sy - b * sx) / n), b: b };
  }

  // ===== API =====
  function bossJsonSeasons_() {
    var out = [];
    try {
      var txt = cachedExternal_('boss.json', GH_DATA_BASE + 'boss.json', SIX_H);
      var all = txt ? JSON.parse(txt) : {};
      Object.keys(all).forEach(function (k) {
        var list = all[k] || [], has = false;
        for (var i = 0; i < list.length; i++) {
          var b = list[i] || {}, hp = b.hp || [];
          if (b.name || b.weak || b.img) { has = true; break; }
          for (var j = 0; j < hp.length; j++) if (Number(hp[j]) > 0) { has = true; break; }
          if (has) break;
        }
        if (has) out.push(Number(k));
      });
    } catch (e) {}
    return out;
  }
  function mergeSeasonList_(base) {
    var set = {};
    (base || []).forEach(function (s) { s = Number(s); if (s) set[s] = true; });
    bossJsonSeasons_().forEach(function (s) { if (s) set[s] = true; });
    return Object.keys(set).map(Number).sort(function (a, b) { return b - a; });
  }
  // 시즌 목록은 ScriptProperties `seasonsList`(RawData) + boss.json의 준비 차수를 합쳐 응답.
  //  doPost가 RawData 시즌을 O(1)로 갱신하고, 아직 타격 기록이 없는 다음 차수는 boss.json만으로도 드롭다운에 노출한다.
  //  프로퍼티 없으면(첫 배포 등) 1회 Season 컬럼 백필 후 저장. → 콜드 bootstrap에서 컬럼읽기(528ms) 제거.
  function getSeasons() {
    if (_rawMemo) {   // 이미 전체를 읽은 실행이면 재사용(중복 읽기 방지)
      var s0 = {}; _rawMemo.forEach(function (r) { s0[r.season] = true; });
      return { ok: true, seasons: mergeSeasonList_(Object.keys(s0).map(Number)) };
    }
    var sl = _props_()['seasonsList'];
    if (sl) { try { var a = JSON.parse(sl); if (a && a.length) return { ok: true, seasons: mergeSeasonList_(a) }; } catch (e) {} }
    // 백필: 프로퍼티 없으면 Season 컬럼 1회 읽어 채움
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RAW);
    if (!sh || sh.getLastRow() < 2) return { ok: true, seasons: mergeSeasonList_([]) };
    var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var col = head.indexOf('Season') + 1; if (col < 1) col = 1;
    var vals = sh.getRange(2, col, sh.getLastRow() - 1, 1).getValues(), set = {};
    for (var i = 0; i < vals.length; i++) { var v = vals[i][0]; if (v !== '' && v != null) set[Number(v)] = true; }
    var seasons = Object.keys(set).map(Number).sort(function (a, b) { return b - a; });
    try { var js = JSON.stringify(seasons); PropertiesService.getScriptProperties().setProperty('seasonsList', js); if (_propsMemo) _propsMemo['seasonsList'] = js; } catch (e) {}
    return { ok: true, seasons: mergeSeasonList_(seasons) };
  }
  // doPost가 새 행 처리 후 호출: 새 시즌이 등장하면 seasonsList 프로퍼티에 추가(getSeasons가 시트 안 읽도록).
  function updateSeasonsList_(touchedSeasons) {
    if (!touchedSeasons || !touchedSeasons.length) return;
    try {
      var p = PropertiesService.getScriptProperties();
      var cur = []; try { cur = JSON.parse(p.getProperty('seasonsList') || '[]') || []; } catch (e) {}
      var set = {}; cur.forEach(function (s) { set[Number(s)] = true; });
      var changed = false;
      touchedSeasons.forEach(function (s) { s = Number(s); if (s && !set[s]) { set[s] = true; changed = true; } });
      if (changed || !cur.length) {
        var arr = Object.keys(set).map(Number).sort(function (a, b) { return b - a; });
        var js = JSON.stringify(arr); p.setProperty('seasonsList', js); if (_propsMemo) _propsMemo['seasonsList'] = js;
      }
    } catch (e) {}
  }

  // ===== 서버 캐시: 같은 시즌·계수모드·데이터 상태면 재집계 없이 즉시 반환(불러오기 가속) =====
  // 키에 RawData 버전(rawSig_)과 수동저장 버전(ovVer_)을 넣어, 새 동기화/오버딜·계수 저장 시 자동 무효화.
  //  ⚠️ 둘 다 **시즌별 ScriptProperties 카운터**(O(1), 시트 안 읽음). 시트 전체를 스캔하던 옛 방식은 캐시 적중에도 수백 ms씩 듦.
  //     `rawver_<시즌>`은 doPost가 그 시즌에 새 행을 넣을 때만 +1 → 끝난 시즌은 불변 → 그 캐시 영속 유지(분석 12시즌 재집계 방지).
  //     ⚠️ 한 실행 내 getProperty 반복(분석=시즌×2회)을 피하려 getProperties()를 1회만 읽어 메모(_propsMemo).
  //     ⚠️ RawData를 수동으로 지우거나 직접 편집하면 rawver가 안 바뀌므로 `?action=flush` 필요(드문 유지보수 한정).
  var _propsMemo = null;
  function _props_() { if (!_propsMemo) { try { _propsMemo = PropertiesService.getScriptProperties().getProperties() || {}; } catch (e) { _propsMemo = {}; } } return _propsMemo; }
  function _bumpProp_(key) {
    try { var p = PropertiesService.getScriptProperties(); var v = String(Number(p.getProperty(key) || '0') + 1); p.setProperty(key, v); if (_propsMemo) _propsMemo[key] = v; }   // 같은 실행(doPost→precompute)에서 즉시 반영
    catch (e) {}
  }
  function rawSig_(season) { return _props_()['rawver_' + Number(season)] || '0'; }
  function bumpRawVer_(season) { _bumpProp_('rawver_' + Number(season)); }   // doPost가 새 행 들어온 시즌에 호출
  // ⚠️ 영속(_OvCache) 캐시도 무효화해야 하므로 ScriptProperties(durable) 사용 — CacheService는 evict 시 stale 위험.
  function ovVer_(season) { return _props_()['ovver_' + Number(season)] || '0'; }
  function bumpOvVer_(season) { _bumpProp_('ovver_' + Number(season)); }
  function coefVer_(season) { return _props_()['coefver_' + Number(season)] || '0'; }
  function bumpCoefVer_(season) { _bumpProp_('coefver_' + Number(season)); }
  function rosterVer_() { return _props_()['rosterver'] || '0'; }
  function bumpRosterVer_() { _bumpProp_('rosterver'); }
  // 전역 flush epoch: ?action=flush/flushCache가 +1 → 모든 캐시 키(ov|·pd|·trall|·시트캐시 sig)가 바뀌어
  //  외부 공유데이터(boss/coef/resmap/dataNik) 갱신 시 인메모리 계산캐시까지 즉시 무효화(종전엔 시트만 비워 최대 6h stale).
  function flushEpoch_() { return _props_()['flushEpoch'] || '0'; }
  function bumpFlushEpoch_() { _bumpProp_('flushEpoch'); }
  function viewSig_(season, coefMode) {
    // 수동 난이도계수는 모드와 무관하게 우선 적용되므로(아래 computeOverview_/computeTrendSummary_),
    // coefVer를 항상 포함해 수동값이 바뀌면 auto·manual·github 캐시가 모두 무효화되도록 한다.
    var sig = rawSig_(season) + '|' + ovVer_(season) + '|m' + coefVer_(season);
    // rosterVer 포함: 길드원 명단(가입/탈퇴)이 바뀌면 개요의 미참여자(nonParticipants) 목록도 갱신.
    return sig + '|c' + CODE_VER + '|r' + rosterVer_() + '|f' + flushEpoch_();
  }
  function trendSig_(season, coefMode) {
    return viewSig_(season, coefMode);
  }

  //  persist=true(=doPost precompute/트리거 백그라운드)일 때만 느린 _OvCache 시트 쓰기. 뷰어 경로는 인메모리(CacheService)만 →
  //  콜드 뷰어에서 store(시트 전체 재기록, 수백~1300ms) 제거. 시트는 백그라운드가 채우고, 뷰어는 인메모리/시트 읽기→없으면 계산.
  function getOverview(season, coefMode, gz, persist) {
    var T = Timer_();
    season = Number(season);
    coefMode = coefMode || 'auto';
    var sig = viewSig_(season, coefMode);   // RawData·오버딜/멤버·수동계수·코드 변경 시 필요한 모드만 키가 바뀜
    var cache = CacheService.getScriptCache();
    var ckey = 'ov|' + season + '|' + coefMode + '|' + sig;
    var prefix = 'ov:' + season + ':' + coefMode;
    var b64 = null, hit = '';
    try { b64 = cache.get(ckey); } catch (e) {}                 // 1) 인메모리(압축본)
    if (b64) hit = 'mem';
    if (!b64) { b64 = ovCacheGet_(prefix, sig); if (b64) { hit = 'sheet'; try { cache.put(ckey, b64, 21600); } catch (e) {} } }   // 2) 시트 영속 캐시
    T.mark('cache');
    if (!b64) {                                                 // 3) 미스 → 재집계 후 압축 저장
      var result = computeOverview_(season, coefMode); T.mark('compute');
      if (!result || !result.ok) return withTiming_(result, T, 'miss');   // 에러 객체는 그대로
      b64 = gzipB64_(JSON.stringify(result)); T.mark('gzip');
      try { cache.put(ckey, b64, 21600); } catch (e) {}        // 인메모리(빠름) — 항상
      if (persist) { ovCachePut_(prefix, sig, b64); T.mark('store'); }   // 시트(느림) — 백그라운드만
      if (!gz) return withTiming_(result, T, 'miss');          // 방금 만든 객체 재사용(디코드 생략)
      return withTiming_({ __gz: b64 }, T, 'miss');
    }
    if (gz) return withTiming_({ __gz: b64 }, T, hit);
    var obj = b64ToObj_(b64); T.mark('decode');                // 클라가 압축 불가면 서버가 풀어서 원본 전달
    if (!obj) { obj = computeOverview_(season, coefMode); hit = 'miss(decodefail)'; }   // 디코드 실패 → 재집계(null 반환 방지)
    return withTiming_(obj, T, hit);
  }

  // ===== 부트스트랩: 초기 로드의 getSeasons + getOverview를 1콜로 묶음(round-trip 축소). =====
  //  체감 느림 1순위는 google.script.run '호출 수'(STATUS §6-A) → 콜드 로드의 직렬 2콜을 1콜로.
  //  반환 ov는 getOverview와 동일 형식(클라 gz 지원 시 {__gz:b64}, 아니면 원본 객체) → 프론트가 unpack(res.ov).
  function getBootstrap(season, coefMode, gz) {
    var T = Timer_();
    coefMode = coefMode || 'auto';
    var seasons = (getSeasons().seasons) || [];                 // 가벼운 Season 컬럼 읽기(_rawMemo 있으면 재사용)
    T.mark('seasons');
    var target = Number(season) || (seasons.length ? seasons[0] : 0);
    var ov = target ? getOverview(target, coefMode, gz) : { ok: false, error: '하드 레이드 데이터가 있는 시즌이 없습니다.' };
    T.mark('overview');                                         // (세부 구간은 ov._t 에 별도로 들어 있음)
    return withTiming_({ ok: true, seasons: seasons, season: target, ov: ov }, T);
  }

  // 첫 화면 뒤 한 번만 받는 읽기 번들. 최근 과거 차수는 불변 스냅샷을 재사용하고,
  // 페이지 진입 때 각각 요청하던 모의전·분석·멤버 데이터를 한 round-trip으로 묶는다.
  function getPrefetchBundle(season, coefMode, gz) {
    var T = Timer_();
    season = Number(season);
    coefMode = coefMode || 'auto';
    var seasons = (getSeasons().seasons) || [];
    var recent = seasons.slice(0, 4), overviews = {};
    recent.forEach(function (s) {
      s = Number(s);
      if (!s || s === season) return;
      try { overviews[String(s)] = getOverview(s, coefMode, false); } catch (e) {}
    });
    T.mark('overviews');
    var practice = null;
    try { practice = getPracticeData(season, false); } catch (e2) { practice = { ok: false, error: String(e2) }; }
    T.mark('practice');
    var analysis = null;
    try { analysis = getMemberTrends(coefMode, false); } catch (e3) { analysis = { ok: false, error: String(e3) }; }
    T.mark('analysis');
    var members = null;
    try { members = getMembers(); } catch (e4) { members = { ok: false, error: String(e4) }; }
    T.mark('members');
    var packed = packResult_({
      ok: true, season: season, coefMode: coefMode,
      overviews: overviews, practice: practice, analysis: analysis, members: members
    }, gz);
    T.mark('pack');
    return withTiming_(packed, T);
  }

  // ===== compute-on-write: 동기화 때 미리 계산해 캐시에 박기 =====
  //  동기화(doPost)로 새 행이 들어온 시즌의 개요/분석 요약을 백그라운드에서 미리 계산해 캐시에 저장.
  //  → '동기화 직후 첫 뷰어가 재집계를 떠안던' 비용을 수집 단계로 옮김(뷰어는 항상 완성본만 읽음, STATUS §6-A1).
  //  doPost가 RawData 락 해제 후 호출(ovCachePut_/trendPut_의 자체 락과 충돌 방지). 실패해도 수집엔 영향 없음.
  //  기본 계수모드(auto)만 미리 만든다(프론트 기본값; manual/github는 종전처럼 첫 조회 때 1회 계산).
  function precomputeOverview_(seasons) {
    var t0 = Date.now(), report = { seasons: [], trendsMs: 0, total: 0 };
    (seasons || []).forEach(function (s) {
      s = Number(s); if (!s) return;
      var ov = null, st = { season: s }, t = Date.now();
      try {
        ov = getOverview(s, 'auto', false, true);
        st.overview = ov && ov._t ? ov._t : { total: Date.now() - t };
        if (!(ov && ov.ok)) ov = null;
      } catch (e) { ov = null; st.overviewError = String(e); }
      t = Date.now();
      try { seasonTrend_(s, 'auto', null, ov); st.trendMs = Date.now() - t; }
      catch (e2) { st.trendMs = Date.now() - t; st.trendError = String(e2); }
      t = Date.now();
      try { practiceDerived_(s, true); st.practiceMs = Date.now() - t; }
      catch (e3) { st.practiceMs = Date.now() - t; st.practiceError = String(e3); }
      report.seasons.push(st);
    });
    // 분석탭은 전 시즌 집계 → 콜드 첫 열기가 느림. 동기화 때 **전 시즌 trend를 미리 데움**(콜드 시즌만 계산, 워밍되면 trendRead만 ~저렴).
    //  → 사용자 첫 분석 열기도 즉시. (과거 시즌은 한 번 데우면 영속, 이후 동기화는 활성 시즌만)
    var tt = Date.now();
    try { var tr = getMemberTrends('auto', false); report.trends = tr && tr._t ? tr._t : null; }
    catch (e4) { report.trendsError = String(e4); }
    report.trendsMs = Date.now() - tt;
    report.total = Date.now() - t0;
    return report;
  }

  // ===== 시간 트리거 워밍 (동기화 없이도 캐시 항상 warm) =====
  //  doPost(동기화)는 blablalink 탭이 켜져 있을 때만 돈다. 그게 없을 때도(또는 배포 직후) 캐시를 미리 채워
  //  뷰어 첫 로드를 <1초로 유지하려면 시간 트리거가 5분마다 warmAll_을 돌린다. 워밍되면 캐시 적중이라 저렴.
  //  기본 배포본은 권한 승인 부담을 줄이기 위해 script.scriptapp scope를 빼 둔다.
  //  꼭 필요하면 appsscript.json에 script.scriptapp scope를 추가한 뒤 편집기에서 setupWarm() 1회 실행. 해제: removeWarm().
  function warmAll_() {
    try {
      var seasons = (getSeasons().seasons) || [];
      seasons.slice(0, 4).forEach(function (s) {   // 최근 4시즌 개요/모의전(시트 포함 persist)
        try { getOverview(s, 'auto', false, true); } catch (e) {}
        try { practiceDerived_(s, true); } catch (e) {}
      });
      try { getMemberTrends('auto', false); } catch (e) {}   // 분석 전 시즌 + 조립본 인메모리
    } catch (e) {}
  }
  function setupWarm() {
    try { ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'warmAll_') ScriptApp.deleteTrigger(t); }); } catch (e) {}
    ScriptApp.newTrigger('warmAll_').timeBased().everyMinutes(5).create();
    warmAll_();   // 즉시 1회 워밍
    return 'warm 트리거 설치됨(5분). 캐시가 항상 미리 채워집니다.';
  }
  function removeWarm() {
    var n = 0; try { ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'warmAll_') { ScriptApp.deleteTrigger(t); n++; } }); } catch (e) {}
    return 'warm 트리거 ' + n + '개 제거됨.';
  }

  // ===== 섹션3 분석: 멤버별 차수 추이 =====
  // 시즌별 '압축 요약'(멤버당 지표 9개)만 _TrendCache 시트에 저장 → 분석탭이 전체 개요 12개를 압축해제하지 않고
  // 작은 요약만 읽음. 키=시즌·계수모드, Sig(rawSig|ovVer) 불일치 시에만 그 시즌만 재계산. (사용자 제안: 분석칸용 정보만 시트에 정리)
  var SHEET_TREND_HDR = ['Key', 'Sig', 'Json'];
  function trendGet_(key, sig) {
    try {
      var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_TREND);
      if (!sh || sh.getLastRow() < 2) return null;
      var v = sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues();
      for (var i = 0; i < v.length; i++) if (String(v[i][0]) === key) return (String(v[i][1]) === String(sig)) ? v[i][2] : null;
      return null;
    } catch (e) { return null; }
  }
  function trendPut_(key, sig, json) {
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(5000);
      var sh = cacheSheet_(SHEET_TREND, SHEET_TREND_HDR);
      var last = sh.getLastRow(), found = -1;
      if (last >= 2) { var v = sh.getRange(2, 1, last - 1, 1).getValues(); for (var i = 0; i < v.length; i++) if (String(v[i][0]) === key) { found = i + 2; break; } }
      var row = [key, String(sig), json];
      if (found > 0) sh.getRange(found, 1, 1, 3).setValues([row]); else sh.getRange(sh.getLastRow() + 1, 1, 1, 3).setValues([row]);
    } catch (e) {} finally { try { lock.releaseLock(); } catch (e2) {} }
  }
  // _TrendCache 전체를 1회만 읽어 맵으로(분석탭이 12시즌 각각 시트를 다시 읽던 것 제거).
  function trendReadAll_() {
    var map = {};
    try {
      var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_TREND);
      if (sh && sh.getLastRow() >= 2) {
        var v = sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues();
        for (var i = 0; i < v.length; i++) { var k = String(v[i][0]); if (k) map[k] = { sig: v[i][1], json: v[i][2] }; }
      }
    } catch (e) {}
    return map;
  }
  // 시즌별 압축 요약: 캐시 적중이면 작은 JSON만 파싱, 미스면 개요 1회 계산 후 요약 저장. (한 시즌 오류는 격리)
  //  trendMap 전달 시: _TrendCache 시트 반복읽기 회피(맵 조회로 대체, 미스 시 맵에도 채움).
  //  ovObj 전달 시(compute-on-write): 그 개요로 요약 생성(이미 계산됨). 아니면 **경량 집계**(computeTrendSummary_).
  function seasonTrend_(s, coefMode, trendMap, ovObj) {
    var sig = trendSig_(s, coefMode), key = 'tr:' + s + ':' + coefMode;
    var cached = trendMap ? ((trendMap[key] && String(trendMap[key].sig) === String(sig)) ? trendMap[key].json : null) : trendGet_(key, sig);
    if (cached) { try { var a = JSON.parse(cached); if (a) return a; } catch (e) {} }
    var arr = null;
    if (ovObj && ovObj.ok && ovObj.members && ovObj.members.length) {   // compute-on-write: 방금 만든 풀 개요 재사용
      var mo0 = memberOverrides_(), roster0 = loadLastRoster_();
      var stepByName0 = {}; (ovObj.bosses || []).forEach(function (b) { var st = Number(b.step) || 0; if (st === 6) st = 5; if (st) stepByName0[b.name] = st; });
      arr = ovObj.members.filter(function (m) { return analysisMemberIncluded_(mo0, roster0, m.openid); })    // 현재 길드원이 아니면 분석(차수 추이)에서 제외(개요엔 포함)
        .map(function (m, idx) {   // members는 contrib 내림차순 정렬 → rank=idx+1
        var bossDmg = {}; if (m.perBossDetail) Object.keys(m.perBossDetail).forEach(function (n) { var st = stepByName0[n]; if (st) bossDmg[st] = (bossDmg[st] || 0) + Math.round((m.perBossDetail[n] && m.perBossDetail[n].damage) || 0); });
        return { openid: String(m.openid || m.nickname), nick: m.nickname, contrib: r1_(m.contrib), share: r1_(m.share),
                 syncLv: m.syncLv || 0, totalDamage: Math.round(m.totalDamage || 0), finalHits: m.finalHits || 0,
                 participations: m.participations || 0, rank: idx + 1, bossDmg: bossDmg };
      });
    } else {
      if (trendMap) trendMap.__cold = (trendMap.__cold || 0) + 1;                   // 콜드 재계산 시즌 수 집계(로그용)
      try { arr = computeTrendSummary_(s, coefMode); } catch (e) { arr = null; }   // 분석 콜드: 지표만 경량 집계(한 시즌 오류 격리)
    }
    if (!arr || !arr.length) return null;
    var js = JSON.stringify(arr);
    try { trendPut_(key, sig, js); if (trendMap) trendMap[key] = { sig: String(sig), json: js }; } catch (e) {}
    return arr;
  }
  // 분석탭 전용 경량 집계: computeOverview_에서 **스쿼드 JSON 파싱·보스 HP/이미지·perBoss 상세·hits 배열**을 모두 생략하고
  //  멤버 지표(contrib/share/syncLv/총딜/막타)만 계산 → 콜드 분석(12시즌)이 개요 풀집계 대비 수배 빠름. 병합/탈퇴/오버딜 동일 반영.
  function computeTrendSummary_(season, coefMode) {
    season = Number(season);
    var all = hardTrendRows_(season);   // 경량 로더(SquadRaw 등 미읽음)
    if (!all.length) return null;
    var bossSum = {}, bossCnt = {}, minStep = {}, grand = 0;
    all.forEach(function (h) {
      bossSum[h.boss] = (bossSum[h.boss] || 0) + h.totalDamage; bossCnt[h.boss] = (bossCnt[h.boss] || 0) + 1; grand += h.totalDamage;
      if (minStep[h.boss] == null || h.step < minStep[h.boss]) minStep[h.boss] = h.step;
    });
    var overallAvg = grand / all.length;
    // 개요와 동일 규칙: 수동(CoefOverrides) 값이 있으면 auto 모드의 보정 기여도도 그 값으로 계산. github 모드만 제작자값 우선.
    var manual = (coefMode === 'github') ? null : loadCoefOverrides_(season);
    var github = (coefMode === 'github') ? fetchCoefJson_(season) : null;
    var coef = {};
    Object.keys(bossSum).forEach(function (n) {
      var c = bossCnt[n] ? overallAvg / (bossSum[n] / bossCnt[n]) : 1;   // auto
      if (github) { var gv = github[minStep[n]]; if (gv != null) c = gv; }
      else if (manual) { var mv = (manual.byName[n] != null) ? manual.byName[n] : manual.byStep[minStep[n]]; if (mv != null) c = mv; }
      coef[n] = c;
    });
    var mo = memberOverrides_(), roster = loadLastRoster_(), mem = {};
    all.forEach(function (h) {
      var oid = memberCanon_(mo, h.openid);
      var m = mem[oid] || (mem[oid] = { openid: oid, nickname: h.nickname, syncLv: 0, participations: 0, totalDamage: 0, finalHits: 0, corrected: 0, bossDmg: {} });
      m.nickname = h.nickname; m.syncLv = Math.max(m.syncLv, h.syncLv); m.participations++; m.totalDamage += h.totalDamage;
      if (h.isFinalHit) m.finalHits++; m.corrected += h.totalDamage * (coef[h.boss] || 1);
      var bst = (h.step === 6) ? 5 : h.step;   // 멤버×보스 딜은 step(1~5) 기준 누적(5보스 4단계=step6→5). 이름 불일치 방지.
      if (bst) m.bossDmg[bst] = (m.bossDmg[bst] || 0) + h.totalDamage;
    });
    var members = Object.keys(mem).map(function (k) { return mem[k]; });
    var memByNick = {}; members.forEach(function (m) { memByNick[m.nickname] = m; });
    loadOverrides_(season).forEach(function (o) {   // 오버딜 반영(총딜·보정)
      var m = memByNick[o.nickname]; if (!m || !o.overdamage) return;
      m.totalDamage += o.overdamage; m.corrected += o.overdamage * (coef[o.boss] || 1);
      var ost = minStep[o.boss] || 0; if (ost === 6) ost = 5;
      if (ost) m.bossDmg[ost] = (m.bossDmg[ost] || 0) + o.overdamage;
    });
    var memTotal = 0, sumCorr = 0; members.forEach(function (m) { memTotal += m.totalDamage; sumCorr += m.corrected; });
    var meanCorrPerHit = all.length ? sumCorr / all.length : 0, avgMember = members.length ? memTotal / members.length : 0;
    members.forEach(function (m) {
      m.share = avgMember > 0 ? m.totalDamage / avgMember * 100 : 0;
      m.contrib = meanCorrPerHit > 0 ? m.corrected / (meanCorrPerHit * 3) * 100 : 0;
    });
    members.sort(function (a, b) { return b.contrib - a.contrib; });
    return members.filter(function (m) { return analysisMemberIncluded_(mo, roster, m.openid); }).map(function (m, idx) {
      return { openid: String(m.openid || m.nickname), nick: m.nickname, contrib: r1_(m.contrib), share: r1_(m.share),
               syncLv: m.syncLv || 0, totalDamage: Math.round(m.totalDamage || 0), finalHits: m.finalHits || 0,
               participations: m.participations || 0, rank: idx + 1, bossDmg: roundBossDmg_(m.bossDmg) };
    });
  }
  function roundBossDmg_(bd) { var out = {}; if (bd) Object.keys(bd).forEach(function (k) { out[k] = Math.round(bd[k] || 0); }); return out; }
  function getMemberTrends(coefMode, gz) {
    var T = Timer_();
    coefMode = coefMode || 'auto';
    var seasons = getSeasons().seasons.slice(0, 12).sort(function (a, b) { return a - b; });
    // 조립 결과를 **인메모리에 통째 캐시**: 시즌별 sig를 합친 키 → 데이터 바뀔 때만 갱신 → 반복 열기는 _TrendCache 시트도 안 읽고 적중.
    var csig = 'c' + CODE_VER; seasons.forEach(function (s) { csig += '|' + s + ':' + trendSig_(s, coefMode); });
    var cache = CacheService.getScriptCache(), ckey = 'trall|' + coefMode + '|' + csig;
    var cb = null; try { cb = cache.get(ckey); } catch (e) {}
    if (cb) { T.mark('mem'); return gz ? withTiming_({ __gz: cb }, T, 'mem') : withTiming_(b64ToObj_(cb) || { ok: false, error: '디코드 실패' }, T, 'mem'); }
    var trendMap = trendReadAll_();                    // _TrendCache 1회 읽기(시즌마다 시트 재읽기 제거)
    T.mark('trendRead');
    var byKey = {}, okSeasons = [];
    seasons.forEach(function (s) {
      var arr = seasonTrend_(s, coefMode, trendMap);
      if (!arr || !arr.length) return;                   // 하드 기록 없는/오류 차수는 제외
      okSeasons.push(s);
      arr.forEach(function (m) {                          // 시즌 오름차순 → 마지막=최신 닉
        var k = String(m.openid || m.nick);
        var e = byKey[k] || (byKey[k] = { key: k, nick: m.nick, series: {} });
        e.nick = m.nick;
        e.series[s] = { contrib: m.contrib, share: m.share, syncLv: m.syncLv, totalDamage: m.totalDamage,
                        finalHits: m.finalHits, participations: m.participations, rank: m.rank, bossDmg: m.bossDmg || {} };
      });
    });
    var members = Object.keys(byKey).map(function (k) { return byKey[k]; })
      .sort(function (a, b) { return a.nick < b.nick ? -1 : (a.nick > b.nick ? 1 : 0); });
    // 시즌별 보스 메타(step→이름/약점색) — 멤버 패널 속성별 통계 헤더/색칠용
    var bossMeta = {};
    okSeasons.forEach(function (s) {
      var bd = fetchBossData_(s), list = [];
      for (var st = 1; st <= 5; st++) { var meta = bd.byStep[st]; if (!meta) continue; var w = meta.weak || ''; list.push({ step: st, name: meta.name || ('보스' + st), weak: w, weakColor: elemColor_(w) }); }
      bossMeta[s] = list;
    });
    T.mark('cold ' + (trendMap.__cold || 0) + '/' + okSeasons.length + '시즌');   // 실제 재계산(콜드) 시즌 / 전체 — 0이면 전부 캐시 적중
    var obj = { ok: true, seasons: okSeasons, members: members, bossMeta: bossMeta };
    var ab = gzipB64_(JSON.stringify(obj)); T.mark('gzip');
    try { cache.put(ckey, ab, 21600); } catch (e) {}   // 조립본 인메모리 저장
    T.mark('cachePut');
    return gz ? withTiming_({ __gz: ab }, T) : withTiming_(obj, T);
  }
  function r1_(v) { return Math.round((Number(v) || 0) * 10) / 10; }

  function emptyOverviewFromBossMeta_(season, coefMode) {
    var bd = fetchBossData_(season), bosses = [];
    for (var s = 1; s <= 5; s++) {
      var meta = bd.byStep[s] || {}, hpArr = meta.hp || [], maxHp = hpArr.length ? (Number(hpArr[hpArr.length - 1]) || 0) : 0;
      var has = !!(meta.name || meta.weak || meta.img || maxHp);
      if (!has) continue;
      var pp = phaseProgress_(hpArr, 0), weak = meta.weak || '';
      bosses.push({
        name: meta.name || ('보스' + s), step: s, weak: weak, weakColor: elemColor_(weak), img: meta.img || '',
        unlimited: Number(s) === 5,
        curLevel: 0,
        phase: pp.phase, phaseRemain: pp.remain, phaseMax: pp.max, phase4Damage: 0,
        maxHp: maxHp, hpByPhase: hpArr, cumDamage: 0, remainHp: maxHp,
        finalHits: 0,
        coef: 1, coefAuto: 1
      });
    }
    if (!bosses.length) return null;
    return {
      ok: true, season: season, coefMode: coefMode, bosses: bosses, members: [],
      nonParticipants: nonParticipantsFrom_({}, memberOverrides_()), overrides: loadOverrides_(season),
      meta: { overallAvg: 0, totalHits: 0, memberCount: 0, grandTotal: 0,
              imgBase: GH_IMG_BASE, bossImgBase: BOSS_IMG_BASE, resourceMap: rosterResourceMap_(), bossOnly: true }
    };
  }

  function computeOverview_(season, coefMode, limitN) {
    var all = hardOf_(season), attackOrdered = false;   // 하드(난이도2)만
    if (!all.length) {
      var empty = emptyOverviewFromBossMeta_(season, coefMode);
      if (empty) return empty;
      return { ok: false, error: '시즌 ' + season + ' 하드 레이드(Difficulty=2) 기록이 없습니다.' };
    }
    // 부분 진행 집계: 실제 공격 순서대로 '첫 N개'만 집계.
    //  ⚠️ RawData 행 순서는 신뢰 불가: 게임 API가 타격을 최신→과거로 주고(타임스탬프 없음) 유저스크립트가 5분마다 신규분만 append하므로,
    //     첫 동기화 큰 묶음(역순)+이후 소량 묶음(시간순)이 섞여 단순 reverse로는 4단계 울트라가 '첫 공격'으로 잡혔다(시즌41 사례).
    //     → 진행 단서(day↑·level↑·step↑)로 초기 게임 상태(저레벨=먼저)를 근사해 정렬한 뒤 첫 N개를 쓴다.
    if (limitN) {
      all = all.map(function (h, i) { return { h: h, i: i }; }).sort(function (a, b) {
        var ah = a.h, bh = b.h;
        if ((ah.day || 0) !== (bh.day || 0)) return (ah.day || 0) - (bh.day || 0);
        if ((ah.level || 0) !== (bh.level || 0)) return (ah.level || 0) - (bh.level || 0);
        if ((ah.step || 0) !== (bh.step || 0)) return (ah.step || 0) - (bh.step || 0);
        return a.i - b.i;
      }).slice(0, Number(limitN)).map(function (x) { return x.h; });
      attackOrdered = true;
    }

    // 보스(이름 기준, 최소 step 순) — step 6=알트아이젠 4단계가 이름으로 자동 합쳐짐
    var minStep = {};
    all.forEach(function (h) { if (minStep[h.boss] == null || h.step < minStep[h.boss]) minStep[h.boss] = h.step; });
    var names = Object.keys(minStep).sort(function (a, b) { return minStep[a] - minStep[b]; });

    var grandTotal = 0; all.forEach(function (h) { grandTotal += h.totalDamage; });
    var overallAvg = grandTotal / all.length;

    var bossHits = {}; names.forEach(function (n) { bossHits[n] = []; });
    all.forEach(function (h) { bossHits[h.boss].push(h); });

    // 난이도계수 — auto(시즌 자동계산)
    var autoCoef = {};
    names.forEach(function (n) {
      var hits = bossHits[n];
      var avg = hits.length ? hits.reduce(function (a, h) { return a + h.totalDamage; }, 0) / hits.length : 0;
      autoCoef[n] = avg > 0 ? overallAvg / avg : 1;
    });

    // 보스 메타(HP/약점/이미지)
    var bd = fetchBossData_(season);
    function bossMeta(n) { return bd.byName[n] || bd.byStep[minStep[n]] || {}; }

    // 약점(=써야 할 속성): boss.json 우선, 없으면 element_id에서 파생
    var weak = {}, weakColor = {};
    names.forEach(function (n) {
      var meta = bossMeta(n);
      var w = meta.weak || weaknessOf_(ownElement_(bossHits[n][0] ? bossHits[n][0].element : ''));
      weak[n] = w; weakColor[n] = elemColor_(w);
    });

    // 난이도계수 출처 선택. 수동(CoefOverrides) 값이 있으면 auto 모드에서도 항상 우선 적용
    //  ("수동 입력하면 그 값을 쓴다" — auto는 수동값이 없을 때만 자동계산값 사용). github 모드만 제작자 coef.json 우선.
    var manual = loadCoefOverrides_(season);
    var github = (coefMode === 'github') ? fetchCoefJson_(season) : {};
    var coef = {};
    names.forEach(function (n) {
      var c = autoCoef[n];
      if (coefMode === 'github') { var gv = github[minStep[n]]; if (gv != null) c = gv; }
      else { var mv = (manual.byName[n] != null) ? manual.byName[n] : manual.byStep[minStep[n]]; if (mv != null) c = mv; }
      coef[n] = c;
    });

    // 멤버 집계(openid 기준; 병합된 openid는 canonical로 합산)
    var mo = memberOverrides_();
    var memMap = {};
    var attackBase = all.length;
    all.forEach(function (h, _ix) {
      var attackIndex = attackOrdered ? _ix : (attackBase - 1 - _ix);   // RawData 수집 순서의 역순 = 실제 공격 순서(0=가장 이른 공격)
      var oid = memberCanon_(mo, h.openid);
      var m = memMap[oid];
      if (!m) m = memMap[oid] = { openid: oid, nickname: h.nickname, syncLv: 0, participations: 0, totalDamage: 0, finalHits: 0, perBoss: {}, perBossDetail: {}, corrected: 0, hits: [], lastIdx: 0 };
      if (m.participations === 0 || attackIndex > m.lastIdx) m.lastIdx = attackIndex;   // 멤버의 마지막 공격순서
      m.nickname = h.nickname; m.syncLv = Math.max(m.syncLv, h.syncLv);
      m.participations++; m.totalDamage += h.totalDamage; if (h.isFinalHit) m.finalHits++;
      var sq = squadOf_(h);
      m.perBoss[h.boss] = (m.perBoss[h.boss] || 0) + h.totalDamage;
      var pd = m.perBossDetail[h.boss] || (m.perBossDetail[h.boss] = { damage: 0, isFinalHit: false, squad: null });
      pd.damage += h.totalDamage; if (h.isFinalHit) pd.isFinalHit = true;
      pd.squad = sq;   // 가장 최근 행(시트 추가 순서)의 스쿼드 — 최대딜 아님
      m.corrected += h.totalDamage * (coef[h.boss] || 1);
      m.hits.push({ boss: h.boss, step: h.step, level: h.level, day: h.day, syncLv: h.syncLv, damage: h.totalDamage, isFinalHit: h.isFinalHit, squad: sq, attackIndex: attackIndex });
    });
    var members = Object.keys(memMap).map(function (k) { return memMap[k]; });

    // 오버딜(막타 추가입력)을 멤버 집계에 반영: 총합딜·보정·보스별딜·막타히트 모두 포함 → share/contrib/효율%가 오버딜을 반영.
    var overrides = loadOverrides_(season);
    var memByNick = {}; members.forEach(function (m) { memByNick[m.nickname] = m; });
    overrides.forEach(function (o) {
      var m = memByNick[o.nickname]; if (!m || !o.overdamage) return;
      m.totalDamage += o.overdamage;
      m.corrected += o.overdamage * (coef[o.boss] || 1);
      if (m.perBoss[o.boss] != null) m.perBoss[o.boss] += o.overdamage;
      var pd = m.perBossDetail[o.boss]; if (pd) pd.damage += o.overdamage;
      for (var hi = m.hits.length - 1; hi >= 0; hi--) { if (m.hits[hi].boss === o.boss && m.hits[hi].isFinalHit) { m.hits[hi].damage += o.overdamage; break; } }
    });

    var memTotal = 0; members.forEach(function (m) { memTotal += m.totalDamage; });   // 오버딜 포함 총합
    var sumCorrected = 0; members.forEach(function (m) { sumCorrected += m.corrected; });
    var meanCorrPerHit = all.length ? sumCorrected / all.length : 0;
    var avgMember = members.length ? memTotal / members.length : 0;
    members.forEach(function (m) {
      m.share = avgMember > 0 ? m.totalDamage / avgMember * 100 : 0;                           // 딜량지분%(평균=100% 정규화)
      m.contrib = meanCorrPerHit > 0 ? m.corrected / (meanCorrPerHit * 3) * 100 : 0;          // 기여도%(보정·정규화)
    });
    members.sort(function (a, b) { return b.contrib - a.contrib; });

    var bosses = names.map(function (n) {
      var hits = bossHits[n];
      var cum = hits.reduce(function (a, h) { return a + h.totalDamage; }, 0);
      var od = overrides.filter(function (o) { return o.boss === n; }).reduce(function (a, o) { return a + o.overdamage; }, 0);
      var meta = bossMeta(n);
      var hpArr = meta.hp || [];                                  // 누적 HP [1단계, 1+2, 1+2+3]
      var maxHp = hpArr.length ? (Number(hpArr[hpArr.length - 1]) || 0) : 0;   // 보스 총 HP = 마지막 누적값(합산 아님!)
      var maxStep = hits.reduce(function (a, h) { return Math.max(a, h.step); }, 0);
      var curLevel = hits.length ? hits[hits.length - 1].level : 0;   // 가장 최근 행의 레벨(API level, 보조)
      var unlimited = maxStep >= 6;   // 4단계(무제한HP) 보스(5보스) → step6 분량 = 4단계 딜량
      var totalDmg = cum + od;
      // 4단계(무제한) 딜량 = step6 기록 합산 + 오버딜(막타가 4단계라 od도 4단계 분량). 5보스만 발생.
      var phase4Damage = unlimited ? (hits.filter(function (h) { return h.step >= 6; }).reduce(function (a, h) { return a + h.totalDamage; }, 0) + od) : 0;
      var pp = phaseProgress_(hpArr, totalDmg - phase4Damage);   // 1~3단계 분량으로 현재 단계 판정
      return {
        name: n, step: minStep[n], weak: weak[n], weakColor: weakColor[n], img: meta.img || '',
        unlimited: unlimited,
        curLevel: curLevel,
        phase: pp.phase, phaseRemain: pp.remain, phaseMax: pp.max, phase4Damage: phase4Damage,
        maxHp: maxHp, hpByPhase: hpArr, cumDamage: totalDmg, remainHp: maxHp - totalDmg,
        finalHits: hits.filter(function (h) { return h.isFinalHit; }).length,
        coef: coef[n], coefAuto: autoCoef[n]
      };
    });

    // 탈퇴(숨김)도 개요엔 표시(과거 기여 보존) — 분석(seasonTrend_)에서만 m.hidden으로 제외. baseline은 전원 기준이라 효율·% 정의 불변.
    members.forEach(function (m) { m.hidden = !!mo.hidden[m.openid]; });
    // 미참여자(0타): 집계·정규화가 끝난 뒤 별도 배열로 — 평균/share/contrib 정의에 영향 없음.
    var attacked = {}; members.forEach(function (m) { attacked[String(m.openid)] = true; });
    var nonParticipants = nonParticipantsFrom_(attacked, mo);
    return {
      ok: true, season: season, coefMode: coefMode, bosses: bosses, members: members, nonParticipants: nonParticipants, overrides: overrides,
      meta: { overallAvg: overallAvg, totalHits: all.length, memberCount: members.length, grandTotal: grandTotal,
              imgBase: GH_IMG_BASE, bossImgBase: BOSS_IMG_BASE, resourceMap: rosterResourceMap_() }
    };
  }

  function getBossDetail(season, bossName, gz) {
    var T = Timer_();
    season = Number(season);
    var hits = hardOf_(season).filter(function (r) { return r.boss === bossName; }); T.mark('load');
    if (!hits.length) return withTiming_({ ok: false, error: '하드 레이드 데이터 없음' }, T);
    // 오버딜은 같은 멤버·보스의 마지막 막타 1건에만 합산(여러 막타 행에 중복 합산하지 않음).
    var odByNick = {};
    loadOverrides_(season).forEach(function (o) { if (o.boss === bossName && o.overdamage) odByNick[o.nickname] = (odByNick[o.nickname] || 0) + o.overdamage; });
    var lastFinal = {};
    hits.forEach(function (h, i) { if (h.isFinalHit) lastFinal[h.nickname] = i; });
    var points = hits.map(function (h, i) {
      var od = (h.isFinalHit && lastFinal[h.nickname] === i) ? (odByNick[h.nickname] || 0) : 0;
      return { nickname: h.nickname, syncLv: h.syncLv, level: h.level, day: h.day,
              damage: h.totalDamage + od, overdamage: od, isFinalHit: h.isFinalHit, squad: squadOf_(h) };
    });
    // X축 = 싱크로 레벨(보스 레벨은 무시)
    var trend = regressPower_(points.map(function (p) { return { x: p.syncLv, y: p.damage }; }));
    var bd = fetchBossData_(season);
    var meta = bd.byName[bossName] || {};
    var minStep = hits.reduce(function (a, h) { return Math.min(a, h.step); }, 99);
    if (!meta.hp) meta = bd.byStep[minStep] || {};
    var w = meta.weak || weaknessOf_(ownElement_(hits[0].element));
    T.mark('build');
    var packed = packResult_({
      ok: true, season: season, boss: bossName, weak: w, weakColor: elemColor_(w), img: meta.img || '',
      points: points, trend: trend,
      meta: { imgBase: GH_IMG_BASE, bossImgBase: BOSS_IMG_BASE, resourceMap: rosterResourceMap_() }
    }, gz);
    T.mark('pack');
    return withTiming_(packed, T);
  }

  // ===== 니케 사전(별칭/버스트/코드/이미지파일): 제작자 GitHub imgSource/dataNik.csv =====
  // 열: 버스트,코드,이름,영문명,파일명,줄임말. 페이지 로드 시 받아 조합 파싱·축약어·코드 자동입력에 사용.
  function fetchNikCsv_() {
    var out = [];
    try {
      var txt = cachedExternal_('dataNik.csv', GH_IMG_BASE + 'dataNik.csv', SIX_H);
      var lines = (txt || '').split(/\r?\n/);
      for (var i = 1; i < lines.length; i++) {
        var ln = lines[i]; if (!ln || !ln.trim()) continue;
        var p = ln.split(',');                       // 이름/별칭에 쉼표 없음 → 단순 split 안전
        var name = (p[2] || '').trim(); if (!name) continue;
        out.push({ n: name, c: (p[1] || '').trim(), f: (p[4] || '').trim(), b: (p[0] || '').trim(), a: (p[5] || '').trim() });
      }
    } catch (e) {}
    return out;
  }

  // ===== 섹션1: 모의전(연습) 기록 =====
  // 저장 구조: Practice 시트 [Season, Nickname, DataJson, UpdatedAt] — 멤버당 1행 JSON.
  //  DataJson = { mode, simple:{1..5:{combo,nikkes[],damage,comment}}, extended:[{attacks:[{boss,combo,nikkes[],damage,comment}],overall}], priority:[idx..] }
  var SHEET_PRACTICE = 'Practice';
  var SHEET_RECOMMENDED = 'RecommendedSquads';

  function loadPractice_(season) {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PRACTICE), out = {};
    if (sh && sh.getLastRow() >= 2) {
      sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().forEach(function (r) {
        if (Number(r[0]) !== Number(season)) return;
        try { out[String(r[1])] = JSON.parse(r[2] || 'null'); } catch (e) {}
      });
    }
    return out;
  }

  function savePracticeData(season, nickname, dataJson) {
    var ss = SpreadsheetApp.getActiveSpreadsheet(), sh = ss.getSheetByName(SHEET_PRACTICE);
    if (!sh) { sh = ss.insertSheet(SHEET_PRACTICE); sh.getRange(1, 1, 1, 4).setValues([['Season', 'Nickname', 'DataJson', 'UpdatedAt']]); sh.setFrozenRows(1); }
    var json = (typeof dataJson === 'string') ? dataJson : JSON.stringify(dataJson);
    if (json.length > 49500) throw new Error('기록 JSON이 셀 한도(50,000자)를 초과했습니다');
    var last = sh.getLastRow(), found = -1;
    if (last >= 2) {
      var v = sh.getRange(2, 1, last - 1, 2).getValues();
      for (var i = 0; i < v.length; i++) if (Number(v[i][0]) === Number(season) && String(v[i][1]) === String(nickname)) { found = i + 2; break; }
    }
    var row = [Number(season), String(nickname), json, new Date()];
    if (found > 0) sh.getRange(found, 1, 1, 4).setValues([row]); else sh.getRange(sh.getLastRow() + 1, 1, 1, 4).setValues([row]);
    return { ok: true };
  }

  function deletePracticeMember(season, nickname) {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PRACTICE);
    if (sh && sh.getLastRow() >= 2) {
      var v = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
      for (var i = v.length - 1; i >= 0; i--) if (Number(v[i][0]) === Number(season) && String(v[i][1]) === String(nickname)) sh.deleteRow(i + 2);
    }
    return { ok: true };
  }

  // ===== 사전 추천 조합: RecommendedSquads [Type, Key, Json, UpdatedAt] =====
  // 시즌별 데이터가 아니라 속성별 전역 추천. single 5행 + triple 10행 = 데이터 15행 고정.
  function recElements_() {
    return ['작열', '수냉', '풍압', '전격', '철갑'];
  }
  function recElemOrder_(code) {
    var e = recElements_();
    for (var i = 0; i < e.length; i++) if (e[i] === code) return i;
    return 99;
  }
  function recTripleCombos_() {
    var e = recElements_(), out = [];
    for (var i = 0; i < e.length - 2; i++) for (var j = i + 1; j < e.length - 1; j++) for (var k = j + 1; k < e.length; k++) out.push([e[i], e[j], e[k]]);
    return out;
  }
  function recMaps_(season) {
    season = Number(season);
    var bd = fetchBossData_(season), raw = loadRawData_().filter(function (r) { return r.season === season; });
    var byStep = {}, byCode = {};
    for (var s = 1; s <= 5; s++) {
      var meta = bd.byStep[s] || {}, weak = meta.weak || '';
      if (!weak) {
        var hit = raw.filter(function (r) { return r.step === s; })[0];
        if (hit) weak = weaknessOf_(ownElement_(hit.element));
      }
      if (weak) { byStep[s] = weak; byCode[weak] = s; }
    }
    return { byStep: byStep, byCode: byCode };
  }
  function emptyRecommended_() {
    return { single: {}, triples: [] };
  }
  function adaptOldRecommended_(obj) {
    obj = obj || {};
    if (!obj.single) obj.single = {};
    if (!obj.triples) obj.triples = [];
    return obj;
  }
  function loadRecommended_(season) {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RECOMMENDED), out = emptyRecommended_();
    if (!sh || sh.getLastRow() < 2) return out;
    var head = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0];
    if (String(head[0]) === 'Season') {
      var old = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
      for (var oi = old.length - 1; oi >= 0; oi--) {
        if (Number(old[oi][0]) !== Number(season) && oi !== old.length - 1) continue;
        try { out = adaptOldRecommended_(JSON.parse(old[oi][1] || '{}') || emptyRecommended_()); } catch (e) { out = emptyRecommended_(); }
        return out;
      }
      return out;
    }
    var maps = recMaps_(season), vals = sh.getRange(2, 1, sh.getLastRow() - 1, Math.min(3, sh.getLastColumn())).getValues();
    vals.forEach(function (r) {
      var type = String(r[0] || ''), key = String(r[1] || ''), obj = {};
      try { obj = JSON.parse(r[2] || '{}') || {}; } catch (e) { obj = {}; }
      if (type === 'single') {
        var step = maps.byCode[key];
        if (step && obj.combo) out.single[String(step)] = { combo: obj.combo };
      } else if (type === 'triple') {
        var attacks = [];
        (obj.attacks || []).forEach(function (a) {
          var code = a.code || maps.byStep[Number(a.boss)] || '';
          var step = maps.byCode[code];
          if (step) attacks.push({ boss: step, combo: a.combo || '' });
        });
        if (attacks.length) out.triples.push({ attacks: attacks });
      }
    });
    return out;
  }
  function saveRecommendedSquads(season, json, adminKey) {
    requireAdmin_(adminKey);
    var ss = SpreadsheetApp.getActiveSpreadsheet(), sh = ss.getSheetByName(SHEET_RECOMMENDED);
    if (!sh) sh = ss.insertSheet(SHEET_RECOMMENDED);
    var obj = emptyRecommended_();
    try { obj = JSON.parse(json || '{}') || emptyRecommended_(); } catch (e) {}
    if (!obj.single) obj.single = {};
    if (!obj.triples) obj.triples = [];
    var maps = recMaps_(season), rows = [], now = new Date(), elems = recElements_();
    elems.forEach(function (code) {
      var step = maps.byCode[code], x = (step && obj.single[String(step)]) || obj.single[code] || {};
      rows.push(['single', code, JSON.stringify({ combo: x.combo || '' }), now]);
    });
    var tripleMap = {};
    (obj.triples || []).forEach(function (set) {
      var byCode = {}, codes = [];
      (set.attacks || []).forEach(function (a) {
        var code = a.code || maps.byStep[Number(a.boss)] || '';
        if (!code) return;
        byCode[code] = a.combo || '';
        codes.push(code);
      });
      codes = codes.filter(function (c, i) { return codes.indexOf(c) === i; }).sort(function (a, b) { return recElemOrder_(a) - recElemOrder_(b); });
      if (codes.length === 3) tripleMap[codes.join(',')] = byCode;
    });
    recTripleCombos_().forEach(function (codes) {
      var key = codes.join(','), byCode = tripleMap[key] || {};
      rows.push(['triple', key, JSON.stringify({ attacks: codes.map(function (code) { return { code: code, combo: byCode[code] || '' }; }) }), now]);
    });
    var needRows = rows.length + 1;
    if (sh.getMaxRows() < needRows) sh.insertRowsAfter(sh.getMaxRows(), needRows - sh.getMaxRows());
    sh.clearContents();
    sh.getRange(1, 1, 1, 4).setValues([['Type', 'Key', 'Json', 'UpdatedAt']]);
    sh.getRange(2, 1, rows.length, 4).setValues(rows);
    if (sh.getMaxRows() > needRows) sh.deleteRows(needRows + 1, sh.getMaxRows() - needRows);
    sh.setFrozenRows(1);
    return { ok: true, recommended: loadRecommended_(season) };
  }

  // ===== 모의전 RawData 파생부(보스메타·니케이름→tid·닉네임) — 동기화 사이 불변 → 캐시(rawSig)+compute-on-write =====
  //  무거운 부분(전체 RawData 읽기 + 전 행 squad JSON 파싱)만 캐시. 가변(저장 모의전/멤버숨김/별칭)은 getPracticeData가 매번 신선히 병합.
  function computePracticeDerived_(season) {
    season = Number(season);
    var all = loadRawData_();
    var raw = all.filter(function (r) { return r.season === season; });
    var bd = fetchBossData_(season);
    // 시즌 보스 1~5 (boss.json byStep 우선, RawData로 이름/속성 보강)
    var bosses = [];
    for (var s = 1; s <= 5; s++) {
      var meta = bd.byStep[s] || {};
      var name = meta.name || '', weak = meta.weak || '';
      var hit = null;
      if (!name || !weak) hit = raw.filter(function (r) { return r.step === s; })[0];
      if (!name && hit) name = hit.boss;
      if (!weak && hit) weak = weaknessOf_(ownElement_(hit.element));
      var hpc = meta.hp || [];
      bosses.push({ step: s, name: name || ('보스' + s), weak: weak, weakColor: elemColor_(weak), img: meta.img || '',
                    hpCum: hpc, maxHp: hpc.length ? (Number(hpc[hpc.length - 1]) || 0) : 0 });
    }
    // 니케이름→tid(이미지용)·이름목록(파싱용): 이 시즌 squad에서 수집
    var nameTid = {}, seasonNicks = {};
    raw.forEach(function (r) {
      if (r.nickname) seasonNicks[r.nickname] = true;
      var sq = []; try { sq = JSON.parse(r.squadRaw || '[]'); } catch (e) {}
      sq.forEach(function (c) { var nm = r.chars[c.slot - 1]; if (nm && nameTid[nm] == null) nameTid[nm] = c.tid; });
    });
    // 멤버닉→openid(전 시즌, hidden 필터용). 이 시즌 sig 키 캐시라 '이 시즌 마지막 동기화 시점의 전역 맵' — hidden 판정엔 충분.
    var nickOpenid = {};
    all.forEach(function (r) { if (r.nickname && nickOpenid[r.nickname] == null) nickOpenid[r.nickname] = String(r.openid); });
    return { bosses: bosses, names: Object.keys(nameTid).sort(), nameTid: nameTid,
             seasonNicks: Object.keys(seasonNicks), nickOpenid: nickOpenid };
  }
  function practiceDerived_(season, persist) {
    season = Number(season);
    var sig = rawSig_(season) + '|c' + CODE_VER + '|f' + flushEpoch_();   // RawData+코드버전+flush epoch(외부데이터 갱신 시 무효화)
    var cache = CacheService.getScriptCache(), ckey = 'pd|' + season + '|' + sig, prefix = 'pd:' + season;
    var b64 = null;
    try { b64 = cache.get(ckey); } catch (e) {}                                          // 1) 인메모리
    if (!b64) { b64 = ovCacheGet_(prefix, sig); if (b64) { try { cache.put(ckey, b64, 21600); } catch (e) {} } }   // 2) _OvCache 시트(pd: 접두)
    if (!b64) {                                                                          // 3) 미스 → 계산 후 압축 저장
      var obj = computePracticeDerived_(season);
      b64 = gzipB64_(JSON.stringify(obj));
      try { cache.put(ckey, b64, 21600); } catch (e) {}        // 인메모리 — 항상
      if (persist) ovCachePut_(prefix, sig, b64);              // 시트(느림) — 백그라운드만
      return obj;                                                                        // 방금 만든 객체 재사용(디코드 생략)
    }
    return b64ToObj_(b64) || computePracticeDerived_(season);   // ⚠️ 디코드 실패해도 절대 null 반환 안 함(재계산) → getPracticeData 크래시 방지
  }

  function getPracticeData(season, gz) {
    var T = Timer_();
    season = Number(season);
    var d = practiceDerived_(season); T.mark('derived');   // 캐시된 무거운 파생부(작으면 적중, 크면 RawData 재집계)
    var mo = memberOverrides_();
    var saved = loadPractice_(season);                  // 가변: 매번 신선히(저장 즉시 반영)
    var recommended = loadRecommended_(season);
    // 멤버: 이 시즌 RawData 닉 ∪ 저장 모의전 닉 ∪ 수동추가 − 탈퇴(숨김). 숨김은 닉→openid로 판정.
    var hiddenNicks = {};
    Object.keys(d.nickOpenid).forEach(function (nk) { if (mo.hidden[d.nickOpenid[nk]]) hiddenNicks[nk] = true; });
    var nickset = {};
    d.seasonNicks.forEach(function (nk) { if (!hiddenNicks[nk]) nickset[nk] = true; });
    Object.keys(saved).forEach(function (nk) { if (!hiddenNicks[nk]) nickset[nk] = true; });
    mo.manual.forEach(function (mm) { if (mm.name) nickset[mm.name] = true; });
    var roster = loadLastRoster_();   // 현재 길드원(미참여 포함) → RawData 없는 준비 차수(예 41차)에서도 모의전 명단 표시
    var syncByNick = {};
    Object.keys(roster.byId).forEach(function (id) {
      if (mo.hidden[id]) return;
      var r = roster.byId[id], nk = String(r.nickname || '').trim();
      if (nk) {
        nickset[nk] = true;
        syncByNick[nk] = Math.max(Number(syncByNick[nk]) || 0, Number(r.syncLv) || 0);
      }
    });
    var members = Object.keys(nickset).sort().map(function (nk) { return { nickname: nk, syncLv: syncByNick[nk] || 0, data: saved[nk] || null }; });
    // 보스 메타는 boss.json에서 매번 신선 병합: 준비 차수(예 41차)는 RawData가 없어 rawSig가 불변이라
    //  practiceDerived 캐시가 boss.json 41 커밋 이전(이름 빈) 값으로 고착됨 → 보스 이름/속성이 '보스N'으로 표시되던 버그.
    var bdz = fetchBossData_(season);
    var freshBosses = (d.bosses || []).map(function (b) {
      var meta = bdz.byStep[b.step] || {}, name = meta.name || b.name, weak = meta.weak || b.weak;
      var hpc = (meta.hp && meta.hp.length) ? meta.hp : b.hpCum;
      return { step: b.step, name: name, weak: weak, weakColor: elemColor_(weak), img: meta.img || b.img,
               hpCum: hpc, maxHp: (hpc && hpc.length) ? (Number(hpc[hpc.length - 1]) || 0) : (b.maxHp || 0) };
    });
    var nik = fetchNikCsv_(), aliases = loadAliases_(), rmap = rosterResourceMap_(); T.mark('aux');
    var packed = packResult_({
      ok: true, season: season, bosses: freshBosses, members: members, syncMap: syncByNick, recommended: recommended,
      names: d.names, nameTid: d.nameTid, nik: nik, aliases: aliases,
      meta: { imgBase: GH_IMG_BASE, bossImgBase: BOSS_IMG_BASE, resourceMap: rmap }
    }, gz);
    T.mark('pack');
    return withTiming_(packed, T);
  }

  // ===== 유니온별 축약어(별칭) — 제작자 dataNik.csv와 분리 저장(덮어쓰기 금지) =====
  // 시트 Aliases [Name, Alias] (니케당 여러 행 가능). 로드 시 buildNikIndex에 병합.
  var SHEET_ALIASES = 'Aliases';
  function loadAliases_() {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_ALIASES), out = [];
    if (sh && sh.getLastRow() >= 2) {
      sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) {
        var nm = String(r[0] || '').trim(), al = String(r[1] || '').trim();
        if (nm && al) out.push({ name: nm, alias: al });
      });
    }
    return out;
  }
  function getAliases() { return { ok: true, aliases: loadAliases_() }; }
  // 옵션에서 호출: 시트 캐시 비우기(외부 공유데이터/개요 재집계 유도)
  function flushCache() {
    try { bumpFlushEpoch_(); } catch (e0) {}   // 인메모리 계산캐시(ov|·pd|·trall|)까지 무효화 — 시트 clear만으론 최대 6h stale였음
    try { CacheService.getScriptCache().removeAll(['bossJsonAll', 'coefJson', 'rosterRid', 'nikCsv']); } catch (e) {}
    try { var ss = SpreadsheetApp.getActiveSpreadsheet(); [SHEET_CACHE, SHEET_OVCACHE, SHEET_TREND].forEach(function (nm) { var sh = ss.getSheetByName(nm); if (sh && sh.getLastRow() >= 2) sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).clearContent(); }); _extMemo = null; } catch (e) {}
    return { ok: true };
  }
  // 전체 덮어쓰기 저장(list = [{name,alias}])
  function saveAliases(json, adminKey) {
    requireAdmin_(adminKey);
    var ss = SpreadsheetApp.getActiveSpreadsheet(), sh = ss.getSheetByName(SHEET_ALIASES);
    if (!sh) { sh = ss.insertSheet(SHEET_ALIASES); }
    sh.clear();
    sh.getRange(1, 1, 1, 2).setValues([['Name', 'Alias']]); sh.setFrozenRows(1);
    var list = [];
    try { list = JSON.parse(json || '[]'); } catch (e) {}
    var rows = (list || []).map(function (x) { return [String(x.name || '').trim(), String(x.alias || '').trim()]; })
      .filter(function (r) { return r[0] && r[1]; });
    if (rows.length) sh.getRange(2, 1, rows.length, 2).setValues(rows);
    return { ok: true, count: rows.length };
  }

  // ===== 정렬 조합 우선순위(유니온 공통) — ScriptProperties 'sortPriority' =====
  //  니케별 우선순위 맵 {니케이름: 숫자}. 같은 버스트 안에서 숫자가 클수록 앞(기본 0).
  //  집계/개요 캐시와 무관(표시 정렬 전용)하므로 CODE_VER에 영향 없음. (0인 항목은 저장 안 함.)
  function getSortPriority() {
    var v = '', map = {};
    try { v = PropertiesService.getScriptProperties().getProperty('sortPriority') || ''; } catch (e) {}
    try { map = JSON.parse(v || '{}') || {}; } catch (e2) { map = {}; }
    if (!map || typeof map !== 'object' || (map instanceof Array)) map = {};   // 옛 배열 포맷은 무시
    return { ok: true, priority: map };
  }
  function saveSortPriority(json, adminKey) {
    requireAdmin_(adminKey);
    var map = {}, out = {};
    try { map = JSON.parse(json || '{}') || {}; } catch (e) {}
    if (map && typeof map === 'object' && !(map instanceof Array)) {
      Object.keys(map).forEach(function (k) { var n = Number(map[k]) || 0; if (n) out[String(k)] = n; });
    }
    try { PropertiesService.getScriptProperties().setProperty('sortPriority', JSON.stringify(out)); } catch (e2) {}
    return { ok: true, count: Object.keys(out).length };
  }

  // ===== 유니온 멤버 관리(운영진) =====
  // LastRoster 시트: 유저스크립트가 GetGuildMembers로 받은 현재 길드원 스냅샷.
  // Members 시트 [Openid, Name, Status, MergedInto, UpdatedAt]: RawData openid 자동수집 위에 덧대는 보정층.
  //  - LastRoster에 없으면 분석탭에서 기본 제외. Members Status='active'는 예외 포함, 'hidden'은 수동 제외.
  //  - MergedInto=<대상 openid> = 닉 변경/중복 동일인 → 대상 openid에 합산.
  //  - Openid='manual:...' = RawData에 아직 없는 수동 등록(모의전 명단용).
  var SHEET_MEMBERS = 'Members';
  var _memOv = null;
  var _lastRoster = null;

  function lastRosterSheet_() {
    var ss = SpreadsheetApp.getActiveSpreadsheet(), sh = ss.getSheetByName(SHEET_LAST_ROSTER);
    if (!sh) sh = ss.insertSheet(SHEET_LAST_ROSTER);
    if (sh.getLastRow() < 1) {
      sh.getRange(1, 1, 1, 6).setValues([['MemberId', 'Nickname', 'Level', 'SyncLv', 'IconId', 'LastSeenAt']]);
      sh.setFrozenRows(1);
    }
    return sh;
  }
  function rosterItemsFromPayload_(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;
    if (payload.items && Array.isArray(payload.items)) return payload.items;
    if (payload.data && payload.data.items && Array.isArray(payload.data.items)) return payload.data.items;
    return [];
  }
  function updateLastRoster_(payload) {
    var items = rosterItemsFromPayload_(payload);
    if (!items.length) return { ok: false, skipped: 'empty roster' };
    var ids = {}, rows = [], now = new Date();
    items.forEach(function (it) {
      var id = String(it.member_id || it.memberId || it.openid || it.openId || '').trim();
      if (!id || ids[id]) return;
      ids[id] = true;
      rows.push([
        id,
        String(it.nickname || it.nick || it.name || '').trim(),
        Number(it.level || 0) || '',
        Number(it.synchro_level || it.syncLv || it.sync_lv || 0) || '',
        String(it.icon_id || it.iconId || '').trim(),
        now
      ]);
    });
    if (!rows.length) return { ok: false, skipped: 'no member_id' };
    rows.sort(function (a, b) { return String(a[1] || a[0]).localeCompare(String(b[1] || b[0])); });
    var hash = Object.keys(ids).sort().join('|');
    var props = PropertiesService.getScriptProperties();
    var oldHash = props.getProperty('lastRosterHash') || '';
    var sh = lastRosterSheet_();
    sh.clear();
    sh.getRange(1, 1, 1, 6).setValues([['MemberId', 'Nickname', 'Level', 'SyncLv', 'IconId', 'LastSeenAt']]);
    sh.setFrozenRows(1);
    sh.getRange(2, 1, rows.length, 6).setValues(rows);
    props.setProperty('lastRosterHash', hash);
    props.setProperty('lastRosterAt', String(now.getTime()));
    _propsMemo = null;
    _lastRoster = null;
    if (hash !== oldHash) bumpRosterVer_();
    return { ok: true, count: rows.length, changed: hash !== oldHash };
  }
  function loadLastRoster_() {
    if (_lastRoster) return _lastRoster;
    var out = { ids: {}, byId: {}, count: 0, at: Number(_props_().lastRosterAt || 0) || 0 };
    try {
      var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LAST_ROSTER);
      if (sh && sh.getLastRow() >= 2) {
        var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues();
        vals.forEach(function (r) {
          var id = String(r[0] || '').trim(); if (!id) return;
          out.ids[id] = true;
          out.byId[id] = { memberId: id, nickname: String(r[1] || ''), level: Number(r[2] || 0) || 0,
                           syncLv: Number(r[3] || 0) || 0, iconId: String(r[4] || ''), at: r[5] };
        });
      }
    } catch (e) {}
    out.count = Object.keys(out.ids).length;
    _lastRoster = out; return out;
  }
  // 미참여(0타) 길드원: LastRoster에 있으나 이번 시즌 공격(attacked openid 집합)이 없는 사람.
  //  - 병합(MergedInto)된 id가 참여했으면 제외, 수동 숨김(hidden/status)도 제외.
  //  - 회색 표시용 최소 필드(닉/싱크로/레벨/아이콘)만 담아 반환(집계엔 미포함).
  function nonParticipantsFrom_(attacked, mo) {
    var roster = loadLastRoster_(), out = [];
    Object.keys(roster.byId).forEach(function (id) {
      var canon = memberCanon_(mo, id);
      if (attacked[String(canon)] || attacked[String(id)]) return;
      var ov = mo.byOpenid[String(id)] || {};
      if (ov.status === 'hidden' || mo.hidden[String(id)]) return;
      var r = roster.byId[id];
      out.push({ openid: id, nickname: r.nickname, syncLv: r.syncLv || 0, level: r.level || 0, iconId: r.iconId || '' });
    });
    out.sort(function (a, b) { return (b.syncLv || 0) - (a.syncLv || 0) || String(a.nickname).localeCompare(String(b.nickname)); });
    return out;
  }
  function analysisMemberIncluded_(mo, roster, openid) {
    var oid = String(openid || '');
    var ov = mo.byOpenid[oid] || {};
    if (ov.status === 'hidden') return false;
    if (ov.status === 'active') return true;
    if (roster && roster.count) return !!roster.ids[oid];
    return !mo.hidden[oid];
  }

  function memberOverrides_() {
    if (_memOv) return _memOv;
    var out = { hidden: {}, merge: {}, manual: [], byOpenid: {} };
    try {
      var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_MEMBERS);
      if (sh && sh.getLastRow() >= 2) {
        sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues().forEach(function (r) {
          var oid = String(r[0] || '').trim(); if (!oid) return;
          var name = String(r[1] || '').trim(), status = String(r[2] || '').trim(), mi = String(r[3] || '').trim();
          out.byOpenid[oid] = { openid: oid, name: name, status: status, mergedInto: mi };
          if (status === 'hidden') out.hidden[oid] = true;
          if (mi) out.merge[oid] = mi;
          if (oid.indexOf('manual:') === 0 && status !== 'hidden') out.manual.push({ openid: oid, name: name });
        });
      }
    } catch (e) {}
    _memOv = out; return out;
  }
  function memberCanon_(mo, oid) { var x = String(oid), seen = {}; while (mo.merge[x] && !seen[x]) { seen[x] = 1; x = mo.merge[x]; } return x; }

  // 관리 UI용 명단: RawData 자동수집(openid→최신닉·마지막시즌) ∪ Members 보정행.
  function getMembers() {
    var raw = loadRawData_(), mo = memberOverrides_(), roster = loadLastRoster_(), auto = {}, latest = 0;
    raw.forEach(function (r) {
      var oid = String(r.openid || ''); if (!oid) return;
      var s = Number(r.season) || 0; if (s > latest) latest = s;
      var a = auto[oid] || (auto[oid] = { openid: oid, nick: r.nickname, lastSeason: s });
      if (s >= a.lastSeason) { a.lastSeason = s; a.nick = r.nickname; }   // 최신 시즌 닉
    });
    var list = [];
    Object.keys(auto).forEach(function (oid) {
      var a = auto[oid], ov = mo.byOpenid[oid] || {};
      var inRoster = roster.count ? !!roster.ids[oid] : true;
      // 수동 제외(hidden) 최우선 → 수동 포함(active) → LastRoster 제외(former) → 예전 미참여(inactive) → active.
      var status = (ov.status === 'hidden') ? 'hidden'
                 : (ov.status === 'active') ? 'active'
                 : ((roster.count && !inRoster) ? 'former'
                 : ((a.lastSeason && latest && a.lastSeason < latest) ? 'inactive' : 'active'));
      list.push({ openid: oid, nick: a.nick, lastSeason: a.lastSeason, fromRaw: true, manual: false,
                  fromRoster: !!roster.ids[oid], inRoster: inRoster, analysisIncluded: analysisMemberIncluded_(mo, roster, oid),
                  status: status, mergedInto: ov.mergedInto || '' });
    });
    Object.keys(roster.byId).forEach(function (oid) {   // 현재 길드원이지만 아직 RawData가 없는 신규/미참여자
      if (auto[oid]) return;
      var rr = roster.byId[oid] || {}, ov = mo.byOpenid[oid] || {};
      list.push({ openid: oid, nick: rr.nickname || oid, lastSeason: 0, fromRaw: false, fromRoster: true,
                  manual: false, inRoster: true, analysisIncluded: analysisMemberIncluded_(mo, roster, oid),
                  status: (ov.status === 'hidden') ? 'hidden' : 'active', mergedInto: ov.mergedInto || '' });
    });
    Object.keys(mo.byOpenid).forEach(function (oid) {   // RawData엔 없는 Members 행(수동추가 등)
      if (auto[oid] || roster.byId[oid]) return;
      var ov = mo.byOpenid[oid];
      var inRoster2 = roster.count ? !!roster.ids[oid] : false;
      list.push({ openid: oid, nick: ov.name || oid, lastSeason: 0, fromRaw: false, manual: oid.indexOf('manual:') === 0,
                  fromRoster: inRoster2, inRoster: inRoster2, analysisIncluded: analysisMemberIncluded_(mo, roster, oid),
                  status: ov.status || (inRoster2 ? 'active' : 'former'), mergedInto: ov.mergedInto || '' });
    });
    list.sort(function (a, b) { return (b.lastSeason - a.lastSeason) || (a.nick < b.nick ? -1 : (a.nick > b.nick ? 1 : 0)); });   // 최근 참여순(내림차순)
    return { ok: true, members: list, latestSeason: latest, rosterCount: roster.count, rosterAt: roster.at || 0 };
  }
  // 보정행만 저장(활성·비병합 자동멤버는 행 불필요). 저장 후 개요·분석 캐시 무효화.
  function saveMembers(json, adminKey) {
    requireAdmin_(adminKey);
    var ss = SpreadsheetApp.getActiveSpreadsheet(), sh = ss.getSheetByName(SHEET_MEMBERS);
    if (!sh) sh = ss.insertSheet(SHEET_MEMBERS);
    sh.clear();
    sh.getRange(1, 1, 1, 5).setValues([['Openid', 'Name', 'Status', 'MergedInto', 'UpdatedAt']]); sh.setFrozenRows(1);
    var list = []; try { list = JSON.parse(json || '[]'); } catch (e) {}
    var now = new Date();
    var rows = (list || []).map(function (x) {
      return [String(x.openid || '').trim(), String(x.name || '').trim(), String(x.status || '').trim(), String(x.mergedInto || '').trim(), now];
    }).filter(function (r) { return r[0] && (r[2] === 'hidden' || r[2] === 'active' || r[3] || r[0].indexOf('manual:') === 0); });   // active는 옛 보정행 호환용(현재 UI는 신규 생성 안 함)
    if (rows.length) sh.getRange(2, 1, rows.length, 5).setValues(rows);
    _memOv = null;
    try { getSeasons().seasons.forEach(function (s) { bumpOvVer_(s); }); } catch (e) {}   // 개요·분석(_OvCache·_TrendCache) 무효화
    return { ok: true, count: rows.length };
  }
