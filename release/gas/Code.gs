/**
 * 니케 유니온 레이드(유레) 데이터 수집 백엔드 (Google Apps Script)
 *
 * 역할:
 *  - Tampermonkey 유저스크립트가 보낸 정규화 레이드 기록을 받아(doPost)
 *  - 중복(Key) 제거 후 신규 행만 RawData 시트에 append
 *  - 함께 받은 캐릭터 매핑은 CharMap 시트에 스냅샷 보관(웹앱/수동 폴백용)
 *  - doGet ?action=charmap 으로 CharMap을 JSON 반환(유저스크립트 최후 폴백)
 *
 * 배포: [배포] > [새 배포] > 유형 "웹 앱"
 *   - 실행: 나
 *   - 액세스 권한: 모든 사용자(익명 포함)
 *   - 발급된 URL을 유저스크립트의 GAS_URL 에 넣는다. (URL은 비공개로 유지)
 */

// ===== 설정 =====
// (선택) 공유 비밀키. 유저스크립트의 SECRET과 같은 값으로 맞추면 URL이 알려져도 외부 기록 주입 차단.
// 비워두면 검사 안 함.
var SECRET = '';

// (선택) 운영자 키. 값을 채우면 **옵션 탭(멤버관리·축약어·난이도계수·추천조합)이 일반 유저에게 숨겨지고**,
// 웹앱 헤더의 "🔒 운영자" 버튼에서 이 키를 1회 입력해야 열린다(브라우저에 기억). 설정 저장 RPC도 서버에서 이 키를 검사.
// 비워두면(기본) 잠금 안 함 = 종전처럼 누구나 옵션 사용. 일반 멤버는 키 입력 필요 없이 개요/모의전/분석만 보면 된다.
var ADMIN_KEY = '';

var SHEET_RAW = 'RawData';
var SHEET_MAP = 'CharMap';
var SHEET_BOSSLV = 'BossLevels';   // GetUnionRaidLevelInfo 관측치(시즌·난이도·보스·단계별 단독 HP)

var RAW_HEADERS = [
  'Season', 'Day', 'Step', 'Difficulty', 'Boss', 'Element', 'Nickname', 'Openid', 'SyncLv',
  'TotalDamage', 'IsFinalHit', 'Level',
  'Char1', 'Char2', 'Char3', 'Char4', 'Char5',
  'Lv1', 'Lv2', 'Lv3', 'Lv4', 'Lv5',
  'Break1', 'Break2', 'Break3', 'Break4', 'Break5',
  'BossId', 'IconId', 'SquadRaw', 'Key', 'ReceivedAt'
];
var MAP_HEADERS = ['prefix', 'name'];
var BOSSLV_HEADERS = ['Season', 'Difficulty', 'Boss', 'Level', 'MaxHp', 'CurrentHp', 'ElementId', 'BossId', 'IconId', 'UpdatedAt'];

// ===== 엔드포인트 =====

function doPost(e) {
  var T = Timer_();
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (lockErr) {
    return jsonOut_({ ok: false, error: 'lock timeout', _t: T.done('lock timeout') });
  }
  T.mark('lock');
  var resp, touched = {};
  try {
    var payload = JSON.parse(e.postData.contents);

    if (SECRET && payload.secret !== SECRET) {
      try { lock.releaseLock(); } catch (e0) {}
      return jsonOut_({ ok: false, error: 'unauthorized', _t: T.done('unauthorized') });
    }

    var records = payload.records || [];
    var charMap = payload.charMap || null;
    var guildMembers = payload.guildMembers || payload.roster || null;

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var rawSheet = getOrCreateSheet_(ss, SHEET_RAW, RAW_HEADERS);
    T.mark('setup');

    var existingKeys = loadKeySet_(rawSheet);
    T.mark('keyScan');
    var now = new Date();
    var COLS = RAW_HEADERS.length, seasonCol = RAW_HEADERS.indexOf('Season');

    // 진행 중(라이브) 시즌 = 유저스크립트가 보낸 liveSeasons(없으면 payload 최고 차수로 폴백).
    //  라이브 시즌은 doPost가 그 시즌 행을 **전부 비우고 fresh 스냅샷으로 재기록** → 게임 API의 최신→과거 순서를 그대로 보존
    //  (append-only로는 첫 동기화 큰 묶음[역순]+이후 소량[시간순]이 섞여 공격순서 복원이 깨졌음).
    var liveSet = {};
    if (payload.liveSeasons && payload.liveSeasons.length) {
      for (var li = 0; li < payload.liveSeasons.length; li++) liveSet[Number(payload.liveSeasons[li])] = true;
    } else {
      var maxS = null;
      for (var mi = 0; mi < records.length; mi++) { var sv = Number(records[mi].season); if (sv && (maxS == null || sv > maxS)) maxS = sv; }
      if (maxS != null) liveSet[maxS] = true;
    }

    // 라이브 시즌의 fresh 스냅샷을 시즌별로 모은다(payload 내 중복은 Key로 1회만, 순서 보존).
    var liveRows = {}, liveSeen = {};
    for (var i = 0; i < records.length; i++) {
      var r = records[i], s = Number(r.season);
      if (!liveSet[s]) continue;
      var k = buildKey_(r), seen = liveSeen[s] || (liveSeen[s] = {});
      if (seen[k]) continue; seen[k] = 1;
      (liveRows[s] || (liveRows[s] = [])).push(recordToRow_(r, k, now));
    }

    // 기존 행의 라이브 시즌별 개수(Season 컬럼만 읽음) → 교체 가드(부분/빈 응답이 멀쩡한 데이터를 지우지 않게).
    var lastRow0 = rawSheet.getLastRow();
    var existCount = {};
    if (lastRow0 >= 2) {
      var seasonsCol = rawSheet.getRange(2, seasonCol + 1, lastRow0 - 1, 1).getValues();
      for (var ec = 0; ec < seasonsCol.length; ec++) { var es = Number(seasonsCol[ec][0]); if (liveSet[es]) existCount[es] = (existCount[es] || 0) + 1; }
    }
    // 교체할 라이브 시즌 = fresh 건수>0 이고 기존 이상(레이드 중엔 줄지 않음 → 작으면 비정상 응답으로 보고 교체 보류).
    var replaceSet = {};
    Object.keys(liveSet).forEach(function (sStr) { var s = Number(sStr), fresh = (liveRows[s] || []).length, ex = existCount[s] || 0; if (fresh > 0 && fresh >= ex) replaceSet[s] = true; });

    // 종료 차수(+교체 보류된 라이브 시즌) = 종전대로 Key dedup-append.
    var appendRows = [];
    for (var ai = 0; ai < records.length; ai++) {
      var ar = records[ai], asn = Number(ar.season);
      if (replaceSet[asn]) continue;
      var akey = buildKey_(ar);
      if (existingKeys.has(akey)) continue;
      existingKeys.add(akey);
      appendRows.push(recordToRow_(ar, akey, now));
      if (ar.season != null) touched[asn] = true;
    }
    T.mark('dedup');

    var replacedCount = 0;
    if (Object.keys(replaceSet).length) {
      // 재기록 경로: 기존 행 중 교체 시즌 제외분(원순서 유지) + 라이브 시즌 fresh(순서 보존) + append를 한 번에 쓴다.
      var existing = (lastRow0 >= 2) ? rawSheet.getRange(2, 1, lastRow0 - 1, COLS).getValues() : [];
      var kept = [];
      for (var ke = 0; ke < existing.length; ke++) { if (!replaceSet[Number(existing[ke][seasonCol])]) kept.push(existing[ke]); }
      var freshLive = [];
      Object.keys(replaceSet).forEach(function (sStr) { var s = Number(sStr); (liveRows[s] || []).forEach(function (row) { freshLive.push(row); }); touched[s] = true; });
      replacedCount = freshLive.length;
      var finalRows = kept.concat(freshLive).concat(appendRows);
      if (finalRows.length) rawSheet.getRange(2, 1, finalRows.length, COLS).setValues(finalRows);
      var surplus = existing.length - finalRows.length;   // 줄어든 만큼 아래 잔여 행 삭제(빈 행 누적 방지)
      if (surplus > 0) rawSheet.deleteRows(2 + finalRows.length, surplus);
      SpreadsheetApp.flush();
    } else if (appendRows.length) {
      // 순수 append(라이브 교체 없음): 전체 재기록 없이 맨 아래 추가만.
      rawSheet.getRange(rawSheet.getLastRow() + 1, 1, appendRows.length, COLS).setValues(appendRows);
      SpreadsheetApp.flush();
    }
    T.mark('append');

    if (charMap) updateCharMap_(ss, charMap);
    T.mark('charMap');

    var rosterResult = null;
    if (guildMembers) rosterResult = updateLastRoster_(guildMembers);
    T.mark('roster');

    var bossLvResult = null;
    if (payload.bossLevels) {
      try { bossLvResult = updateBossLevels_(payload.bossLevels); }
      catch (eb) { bossLvResult = { ok: false, error: String(eb) }; }
      // 새 단계 HP가 관측되면 그 시즌 캐시 무효화(개요/모의전의 단계HP가 즉시 갱신되도록)
      if (bossLvResult && bossLvResult.added && payload.bossLevels.season) touched[Number(payload.bossLevels.season)] = true;
    }
    T.mark('bossLevels');

    resp = { ok: true, added: appendRows.length, replaced: replacedCount, skipped: records.length - appendRows.length - replacedCount };
    if (rosterResult) resp.roster = rosterResult;
    if (bossLvResult) resp.bossLevels = bossLvResult;
  } catch (err) {
    try { lock.releaseLock(); } catch (e2) {}
    return jsonOut_({ ok: false, error: String(err), _t: T.done('error') });
  }

  // append/dedup은 락 안에서 끝났으니 먼저 해제 → precompute가 쓰는 캐시 락과 충돌(재진입) 방지.
  try { lock.releaseLock(); } catch (e3) {}
  T.mark('unlock');

  // 새 행 들어온 시즌의 데이터 버전 +1 → 그 시즌 캐시 무효화. ⚠️ precompute보다 먼저(+precompute 실패해도) 실행해야
  //  stale 캐시(새 행 빠진 옛 결과)를 방지. precompute는 곧바로 새 버전 키로 완성본을 다시 채움.
  try { Object.keys(touched).forEach(function (s) { bumpRawVer_(Number(s)); }); } catch (e4) {}
  try { updateSeasonsList_(Object.keys(touched)); } catch (e4b) {}   // 새 시즌 등장 시 seasonsList 갱신(getSeasons 시트읽기 제거)
  T.mark('versions');

  // compute-on-write: 새 행이 들어온 시즌의 개요/분석을 미리 계산해 캐시에 저장(다음 뷰어는 완성본만 읽음).
  //  → 동기화 직후 첫 로드의 재집계 1회를 백그라운드 수집 단계로 옮김. 실패해도 수집 응답엔 영향 없음.
  var pre = null;
  if (resp.added || resp.replaced) {
    try { pre = precomputeOverview_(Object.keys(touched)); }
    catch (e5) { pre = { error: String(e5) }; }
  }
  T.mark('precompute');
  resp._t = T.done();
  if (pre) resp._t.precompute = pre;

  return jsonOut_(resp);
}

// 참고: doGet 라우터는 Dashboard.gs에 있습니다(GAS는 프로젝트당 doGet 1개).
//       charmap 응답은 아래 헬퍼로 분리 — Dashboard.gs의 doGet에서 호출.
function charMapOutput_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_MAP);
  var map = {};
  if (sheet && sheet.getLastRow() >= 2) {
    var vals = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (vals[i][0] !== '') map[String(vals[i][0])] = vals[i][1];
    }
  }
  return jsonOut_({ ok: true, map: map });
}

// ===== 헬퍼 =====

function buildKey_(r) {
  // 기본 중복키: season|day|nickname|boss|totalDamage
  return [r.season, r.day, r.nickname, r.boss, r.totalDamage].join('|');
}

function recordToRow_(r, key, now) {
  var c = r.chars || [], l = r.levels || [], b = r.breaks || [];
  return [
    r.season, r.day, r.step, r.difficulty, r.boss, r.element, r.nickname, r.openid, r.syncLv,
    r.totalDamage, r.isFinalHit, r.level,
    c[0] || '', c[1] || '', c[2] || '', c[3] || '', c[4] || '',
    l[0] || 0, l[1] || 0, l[2] || 0, l[3] || 0, l[4] || 0,
    b[0] || '', b[1] || '', b[2] || '', b[3] || '', b[4] || '',
    r.bossId || '', r.iconId || '', r.squadRaw || '', key, now
  ];
}

function loadKeySet_(sheet) {
  var set = new Set();
  var last = sheet.getLastRow();
  if (last < 2) return set;
  var keyCol = RAW_HEADERS.indexOf('Key') + 1;
  var vals = sheet.getRange(2, keyCol, last - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (vals[i][0] !== '') set.add(String(vals[i][0]));
  }
  return set;
}

/**
 * 받은 매핑(prefix -> name)을 CharMap에 누락분만 추가.
 * 기존 행(자동/수동 편집)은 보존 → 사용자가 손본 이름이 덮어써지지 않음.
 * (특정 이름을 강제 갱신하려면 해당 행을 지우면 다음 전송 때 다시 채워짐)
 */
function updateCharMap_(ss, charMap) {
  var sheet = getOrCreateSheet_(ss, SHEET_MAP, MAP_HEADERS);
  var have = new Set();
  var last = sheet.getLastRow();
  if (last >= 2) {
    var vals = sheet.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < vals.length; i++) have.add(String(vals[i][0]));
  }
  var add = [];
  for (var p in charMap) {
    if (!charMap.hasOwnProperty(p)) continue;
    if (!have.has(String(p))) add.push([p, charMap[p]]);
  }
  if (add.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, add.length, MAP_HEADERS.length).setValues(add);
  }
}

// 보스 단계별 HP 업서트 — 키: Season|Difficulty|Boss|Level.
//  MaxHp는 단계 고정값이라 최초 1회만 기록(불변), CurrentHp/UpdatedAt만 매번 갱신.
//  진행 중 시즌에만 관측 가능한 값이라(정산 후 API 제공 여부 미확인) 보일 때 쌓아두는 게 목적.
function updateBossLevels_(bl) {
  var season = Number(bl && bl.season);
  var entries = (bl && bl.entries) || [];
  if (!season || !entries.length) return { ok: false, reason: 'empty' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = getOrCreateSheet_(ss, SHEET_BOSSLV, BOSSLV_HEADERS);
  var last = sh.getLastRow();
  var index = {}; // Season|Difficulty|Boss|Level -> 행 번호
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, 4).getValues();
    for (var i = 0; i < vals.length; i++) {
      index[[vals[i][0], vals[i][1], vals[i][2], vals[i][3]].join('|')] = i + 2;
    }
  }
  var now = new Date(), added = 0, updated = 0, newRows = [];
  entries.forEach(function (en) {
    var boss = String(en.boss || '').trim();
    var lvl = Number(en.level), diff = Number(en.difficulty);
    if (!boss || !lvl || !diff) return;
    var key = [season, diff, boss, lvl].join('|');
    var rowNum = index[key];
    if (rowNum) {
      sh.getRange(rowNum, 6, 1, 1).setValue(Number(en.currentHp) || 0);   // CurrentHp
      sh.getRange(rowNum, 10, 1, 1).setValue(now);                        // UpdatedAt
      updated++;
    } else {
      newRows.push([season, diff, boss, lvl, Number(en.maxHp) || 0, Number(en.currentHp) || 0,
                    String(en.elementId || ''), String(en.bossId || ''), String(en.iconId || ''), now]);
      index[key] = -1; // 같은 배치 내 중복 방지
      added++;
    }
  });
  if (newRows.length) {
    sh.getRange(sh.getLastRow() + 1, 1, newRows.length, BOSSLV_HEADERS.length).setValues(newRows);
  }
  return { ok: true, added: added, updated: updated };
}

function getOrCreateSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
