// ==UserScript==
// @name         Nikke Union Raid -> Google Sheet Sync
// @namespace    http://tampermonkey.net/
// @version      1.9
// @description  blablalink 유니온 레이드(유레) 데이터를 자동 수집해 Google Apps Script 웹앱으로 전송. 화면 우측 패널에서 설정 입력→저장(코드 수정 불필요, GM_setValue 영속). 진행 중 시즌은 GetUnionRaidData 활성 호출 + 페이지 응답 라이브 캡처(이중화). 보스 단계별 HP(GetUnionRaidLevelInfo)도 함께 수집. 캐릭터 매핑은 라이브 캡처 → CDN → GitHub → CharMap 계층형 폴백.
// @author       You
// @match        *://*.blablalink.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @connect      api.blablalink.com
// @connect      sg-tools-cdn.blablalink.com
// @connect      raw.githubusercontent.com
// ==/UserScript==

(function () {
    'use strict';

    // ==================================================================================
    // [설정 구역] — 여기만 채우면 됩니다
    // ==================================================================================

    // GAS 웹앱 배포 URL — 반드시 끝이 …/exec 여야 함(브라우저로 열면 {"ok":true,...}가 나와야 정상).
    var GAS_URL = 'PASTE_YOUR_GAS_WEBAPP_URL_HERE';

    // (선택) 공유 비밀키 — GAS의 SECRET과 같은 값으로 맞추면, URL이 알려져도 외부에서 기록 주입 불가.
    // 비워두면 검사 안 함(혼자 본인 PC에서만 수집한다면 비워둬도 OK).
    var SECRET = '';

    // 길드/지역 식별자 — 각 길드가 자기 값으로 채워야 함(배포 가이드 참고).
    //  찾는 법: blablalink 유니온 레이드 페이지에서 F12 → Network → GetUnionRaidDataOfGuildSeason 요청의
    //          Payload(요청 본문)에 있는 area_id / guild_id 를 그대로 복사.
    var AREA_ID = 83;    // 서버 지역 ID: 일본 81 / 북미 82 / 한국 83 / 글로벌 84 / 동남아 85
    var GUILD_ID = 'PASTE_YOUR_GUILD_ID_HERE';   // 반드시 본인 길드 ID (이름 옆에 숫자로 된거)로

    // 시즌 자동 탐색: START부터 위로 올라가며, 데이터 없는(또는 호출 실패) 첫 시즌에서 즉시 멈춤.
    // → 새 시즌(41차…)이 열리면 자동 포함. 보통 손댈 필요 없음.
    //   (중간에 일시적 오류로 끊겨도 다음 주기에 dedup으로 자동 복구됨)
    var START_SEASON_ID = 1000035; // 수집 시작 = 가장 오래된 시즌 (season_id = 1000000 + 시즌번호)
    var MAX_SEASON_PROBE = 80;     // 안전 상한(혹시 데이터가 안 끝날 때 무한루프 방지)
    var PROBE_NEW_EVERY = 1;       // 새 차수 탐지 주기(사이클). 매 동기화마다 knownMax+1까지만 확인해 새 차수 전환을 놓치지 않음.
    var INITIAL_EMPTY_SEASON_TOLERANCE = 12; // 첫 실행 때 빈 차수가 이어져도 여기까지는 계속 탐색(과거 차수 미참여 길드 대비).

    // 자동 동기화 주기
    var SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5분 (테스트로 빨리 확인하려면 1 * 60 * 1000)
    var FIRST_RUN_DELAY_MS = 3000;        // 로드 후 첫 실행 지연(페이지가 캐릭터 JSON을 먼저 불러올 여유)

    // [디버그] true로 두고 새로고침하면 API 첫 기록 전체를 콘솔에 1회 덤프(사용 가능한 필드 확인용). 확인 후 false로.
    var DEBUG_DUMP_RAW = false;

    // 캐릭터 매핑 폴백 소스
    //  - 1순위: 라이브 캡처(아래 토글) / 2순위: 알려진 CDN URL / 3순위: GitHub raw / 최후: GAS CharMap
    var USE_LIVE_CAPTURE = true; // 페이지가 불러오는 캐릭터 JSON 라이브 캡처 사용. 이름이 이상하면 false로.
    var KNOWN_MAP_URL  = 'https://sg-tools-cdn.blablalink.com/wi-97/ni-77/ffc69c4074f27bc772acbe869127e616.json';
    var GITHUB_MAP_URL = ''; // 예: 'https://raw.githubusercontent.com/<user>/<repo>/main/nikke_map.json'

    // 시즌 표(공개 CDN, 무인증) — 진행 중 시즌 번호 판정용. 해시 경로라 게임 갱신 시 URL이 바뀔 수 있음(바뀌면 knownMax+1로 폴백).
    var SEASON_TABLE_URL = 'https://sg-tools-cdn.blablalink.com/rm-58/a7f993363fe3e2df8a4a7e579decc872.json';

    // 레이드 API
    //  - OfGuildSeason: season_id 명시 = 종료(정산)된 시즌만 데이터 제공
    //  - GetUnionRaidData: 시즌 미지정 = 진행 중 시즌(페이지가 쓰는 방식, ure_catalog (4).json로 확인)
    var API_URL = 'https://api.blablalink.com/api/game/proxy/Game/GetUnionRaidDataOfGuildSeason';
    var CURRENT_API_URL = 'https://api.blablalink.com/api/game/proxy/Game/GetUnionRaidData';
    var LEVEL_API_URL = 'https://api.blablalink.com/api/game/proxy/Game/GetUnionRaidLevelInfo'; // 진행 중 보스 단계별 max_hp/current_hp
    var USER_INFO_URL = 'https://api.blablalink.com/api/ugc/proxy/standalonesite/User/GetUserInfoNew'; // intl_open_id 자동 획득용
    var GUILD_MEMBERS_URL = 'https://api.blablalink.com/api/game/proxy/Game/GetGuildMembers';
    var X_COMMON_PARAMS = '{"game_id":"16","area_id":"global","source":"pc_web","intl_game_id":"29080","language":"ko","env":"prod","data_statistics_scene":"outer","data_statistics_page_id":"https://www.blablalink.com/shiftyspad","data_statistics_client_type":"pc_web","data_statistics_lang":"ko"}';

    // ==================================================================================
    // [설정 영속] — 화면 우측 패널에서 입력한 값을 GM_setValue에 저장(브라우저에 영속).
    //  저장된 값이 있으면 위 코드 기본값보다 **우선** 적용 → 코드를 직접 고치지 않아도 됨.
    //  (코드의 PASTE_… 기본값은 패널을 처음 쓸 때까지의 폴백일 뿐)
    // ==================================================================================
    function cfgGet(k, def) { try { if (typeof GM_getValue !== 'function') return def; var v = GM_getValue('ure_' + k, null); return (v === null || v === undefined || v === '') ? def : v; } catch (e) { return def; } }
    function cfgSet(k, v) { try { if (typeof GM_setValue === 'function') GM_setValue('ure_' + k, v); } catch (e) {} }
    GAS_URL  = cfgGet('gasUrl', GAS_URL);
    SECRET   = cfgGet('secret', SECRET);
    GUILD_ID = cfgGet('guildId', GUILD_ID);
    AREA_ID  = Number(cfgGet('areaId', AREA_ID)) || AREA_ID;
    SYNC_INTERVAL_MS = (Number(cfgGet('intervalMin', SYNC_INTERVAL_MS / 60000)) || (SYNC_INTERVAL_MS / 60000)) * 60000;
    var SYNC_SCOPE = 'all';                             // 수동 버튼용: 'all'(시즌 범위) | 'current'(현재 시즌만)
    var SEASON_LIMIT = Number(cfgGet('seasonLimit', 0)) || 0; // 0=전체 자동 탐색, 40=40차까지, 41=40차 종료시즌+41차 진행중
    var AUTO_ON    = String(cfgGet('autoOn', '1')) !== '0';   // 자동갱신 ON/OFF

    // ==================================================================================
    // [네트워크 후킹] — 페이지가 스스로 불러오는 캐릭터 매핑 JSON을 가로채 라이브 캡처 (1순위)
    // ==================================================================================

    var liveCharList = null;   // 원본 배열 [{ id, name_localkey:{ name }, ... }]
    var liveCharValid = -1;    // 채택된 파일의 유효 캐릭 수(더 풍부한 파일로만 교체)

    // 니케 로스터 판별: 이름 + 니케 고유 필드(버스트스킬/제조사/등급).
    // → 같은 CDN의 다른 JSON(아이템/스킬/보스 등, id 체계가 스쿼드 tid와 다름)을 배제해 Unknown 방지.
    function isNikkeEntry(it) {
        return it && it.id != null && it.name_localkey && it.name_localkey.name &&
               (it.use_burst_skill || it.corporation || it.original_rare);
    }
    function countNikke(json) {
        var n = 0;
        for (var i = 0; i < json.length; i++) if (isNikkeEntry(json[i])) n++;
        return n;
    }
    var NIKKE_ROSTER_MAX = 1000;        // 니케 로스터 추정 상한. 이보다 크면 코스튬/변형 포함 대형 JSON으로 보고 배제(id 체계가 tid와 다를 수 있음)
    function captureMap(json) {
        if (!USE_LIVE_CAPTURE || !Array.isArray(json) || !json.length) return;
        var v = countNikke(json);
        if (v === 0 || v > NIKKE_ROSTER_MAX) return; // 니케 로스터가 아니거나 비정상적으로 큼 → 무시
        if (v > liveCharValid) {        // 가장 풍부한 '니케' 파일만 채택
            liveCharValid = v;
            liveCharList = json;
            console.log('[유레싱크] 캐릭터 매핑 채택 (니케 ' + v + '종)');
        }
    }
    function isMapUrl(u) {
        return u && /sg-tools-cdn\.blablalink\.com\/.+\.json(\?|$)/i.test(String(u));
    }

    // ----------------------------------------------------------------------------------
    // 레이드 응답 라이브 캡처 — 진행 중 시즌 대응(전임자 다운로더와 같은 원리)
    // GetUnionRaidDataOfGuildSeason에 season_id를 명시한 활성 호출은 종료(정산) 시즌만 주고
    // 진행 중 시즌은 빈 participate_data를 반환함. 화면에 보이는 데이터는 페이지가 직접
    // 받아오므로, 그 응답을 가로채 다음 동기화에 합류시킨다(GAS dedup이 중복 제거).
    // ----------------------------------------------------------------------------------

    var liveRaidBuf = {};        // seasonId -> { keys:{}, recs:[] } 페이지가 받은 원본 기록 누적
    var capturePokeTimer = null; // 캡처 직후 1회 조기 동기화 예약

    function isRaidUrl(u) {
        return u && /GetUnionRaidData/i.test(String(u));
    }
    function raidRecKey(rec) {
        return [rec.day, rec.step, rec.difficulty, rec.nickname, rec.total_damage].join('|');
    }
    function seasonIdFromBody(bodyStr) {
        try {
            var b = JSON.parse(bodyStr);
            var sid = Number(b && b.season_id);
            return (sid && sid >= 1000000) ? sid : 0;
        } catch (e) { return 0; }
    }

    var seasonTableCache = { at: 0, promise: null };
    function currentSeasonId() { // 시즌표에서 '지금 진행/정산 중' 시즌 id (없으면 시작된 것 중 최신). 6시간마다 재조회(시즌 전환 대비).
        var now = Date.now();
        if (!seasonTableCache.promise || now - seasonTableCache.at > 6 * 3600 * 1000) {
            seasonTableCache.at = now;
            seasonTableCache.promise = gmGetJson(SEASON_TABLE_URL).then(function (list) {
                if (!Array.isArray(list)) return 0;
                var ts = Date.now() / 1000, cur = 0;
                list.forEach(function (s) {
                    if (s && s.start_ts && s.start_ts <= ts && ts <= (s.caculate_ts || s.end_ts || 0)) cur = s.id;
                });
                if (!cur) list.forEach(function (s) { if (s && s.start_ts <= ts && s.id > cur) cur = s.id; });
                return cur || 0;
            });
        }
        return seasonTableCache.promise;
    }

    function captureRaid(json, reqBodyStr) {
        var pd = json && json.data && json.data.participate_data;
        if (!Array.isArray(pd) || !pd.length) return;
        var sid = seasonIdFromBody(reqBodyStr);
        var attach = function (resolvedSid) {
            if (!resolvedSid) { console.warn('[유레싱크] 라이브 캡처: 시즌 번호를 정하지 못해 ' + pd.length + '건을 버림(시즌표 접근 불가)'); return; }
            var buf = liveRaidBuf[resolvedSid] || (liveRaidBuf[resolvedSid] = { keys: {}, recs: [] });
            var added = 0;
            for (var i = 0; i < pd.length; i++) {
                var k = raidRecKey(pd[i]);
                if (!buf.keys[k]) { buf.keys[k] = 1; buf.recs.push(pd[i]); added++; }
            }
            if (added) {
                console.log('[유레싱크] 라이브 캡처: 시즌 ' + (resolvedSid - 1000000) + '차 ' + added + '건 확보(누적 ' + buf.recs.length + '건) — 곧 동기화에 합류');
                if (!capturePokeTimer) capturePokeTimer = setTimeout(function () { capturePokeTimer = null; runOnce(); }, 5000);
            }
        };
        if (sid) attach(sid);
        else currentSeasonId().then(function (cur) { attach(cur || (knownMax ? knownMax + 1 : 0)); });
    }

    var w = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    var originalFetch = w.fetch.bind(w); // 활성 호출용으로 원본 보관(후킹 전)

    w.fetch = function () {
        var args = arguments;
        var p = originalFetch.apply(this, args);
        try {
            var u = (args[0] && args[0].url) ? args[0].url : args[0];
            if (isMapUrl(u)) {
                p.then(function (r) { return r.clone().json(); }).then(captureMap).catch(function () {});
            }
            if (isRaidUrl(u)) {
                var body = (args[1] && typeof args[1].body === 'string') ? args[1].body : '';
                p.then(function (r) { return r.clone().json(); }).then(function (j) { captureRaid(j, body); }).catch(function () {});
            }
        } catch (e) {}
        return p;
    };

    var XHR = w.XMLHttpRequest.prototype;
    var xhrOpen = XHR.open;
    var xhrSend = XHR.send;
    XHR.open = function (method, url) { this._url = url; return xhrOpen.apply(this, arguments); };
    XHR.send = function (body) {
        this._body = (typeof body === 'string') ? body : '';
        this.addEventListener('load', function () {
            try { if (isMapUrl(this._url)) captureMap(JSON.parse(this.responseText)); } catch (e) {}
            try { if (isRaidUrl(this._url)) captureRaid(JSON.parse(this.responseText), this._body); } catch (e) {}
        });
        return xhrSend.apply(this, arguments);
    };

    // ==================================================================================
    // [GM 요청 헬퍼] — GAS/CDN/GitHub 같은 교차 출처 호출(응답 읽기용)
    // ==================================================================================

    function gmGetJson(url) {
        return new Promise(function (resolve) {
            GM_xmlhttpRequest({
                method: 'GET', url: url,
                onload: function (r) { try { resolve(JSON.parse(r.responseText)); } catch (e) { resolve(null); } },
                onerror: function () { resolve(null); },
                ontimeout: function () { resolve(null); }
            });
        });
    }
    function gmPostJson(url, bodyStr) {
        return new Promise(function (resolve) {
            GM_xmlhttpRequest({
                method: 'POST', url: url, data: bodyStr,
                headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, // 단순 요청 → CORS 프리플라이트 회피
                onload: function (r) { try { resolve(JSON.parse(r.responseText)); } catch (e) { resolve({ raw: r.responseText }); } },
                onerror: function () { resolve(null); },
                ontimeout: function () { resolve(null); }
            });
        });
    }

    // ==================================================================================
    // [매핑 구성] — 계층형 폴백
    // ==================================================================================

    function listToNameMap(list) {
        var map = {};
        if (Array.isArray(list)) {
            list.forEach(function (it) {
                if (it && it.id != null && it.name_localkey && it.name_localkey.name) {
                    map[Math.floor(it.id / 100)] = it.name_localkey.name;
                }
            });
        }
        return map;
    }

    function buildNameMap() {
        // 1순위: 라이브 캡처
        var map = listToNameMap(liveCharList);
        if (Object.keys(map).length) return Promise.resolve(map);

        // 2순위: 알려진 CDN URL
        return gmGetJson(KNOWN_MAP_URL).then(function (list) {
            map = listToNameMap(list);
            if (Object.keys(map).length) return map;

            // 3순위: GitHub raw
            var step = GITHUB_MAP_URL ? gmGetJson(GITHUB_MAP_URL) : Promise.resolve(null);
            return step.then(function (gh) {
                map = listToNameMap(gh);
                if (Object.keys(map).length) return map;

                // 최후: GAS CharMap (prefix -> name 직접)
                return gmGetJson(GAS_URL + '?action=charmap').then(function (cm) {
                    return (cm && cm.map) ? cm.map : {};
                });
            });
        });
    }

    // ==================================================================================
    // [가공] — 응답 → 정규화 레코드
    // ==================================================================================

    function gradeFromTid(tid) {
        var v = tid % 100;
        if (v === 1) return '0돌';
        if (v === 2) return '1돌';
        if (v === 3) return '2돌';
        if (v === 4) return '3돌';
        if (v >= 5 && v <= 11) return (v - 4) + '코강';
        return '?(' + v + ')';
    }
    function cleanBoss(name) {
        return (name || 'Unknown').replace(/\s*\[.*?\]/g, '').trim();
    }

    function normalize(json, seasonId, nameMap) {
        var out = [];
        var season = seasonId - 1000000;
        var pd = json && json.data && json.data.participate_data;
        if (!Array.isArray(pd)) return out;

        for (var i = 0; i < pd.length; i++) {
            var rec = pd[i];
            var boss = cleanBoss(rec.name_localvalues ? rec.name_localvalues.ko : '');
            var chars = ['', '', '', '', ''];
            var levels = [0, 0, 0, 0, 0];
            var breaks = ['', '', '', '', ''];

            if (Array.isArray(rec.squad)) {
                for (var j = 0; j < rec.squad.length; j++) {
                    var c = rec.squad[j];
                    var s = c.slot;
                    if (s >= 1 && s <= 5) {
                        var tid = c.tid;
                        chars[s - 1] = nameMap[Math.floor(tid / 100)] || ('Unknown(' + tid + ')');
                        levels[s - 1] = c.lv || c.level || 0;
                        breaks[s - 1] = gradeFromTid(tid);
                    }
                }
            }

            var syncLv = levels.reduce(function (m, v) { return v > m ? v : m; }, 0);
            out.push({
                season: season,
                day: (rec.day || 0) + 1,                       // 1=일반, 2=하드(난이도와 일치)
                step: rec.step || 0,                           // 보스 위치(1~)
                difficulty: rec.difficulty || 0,               // 1=일반, 2=하드
                nickname: rec.nickname,
                openid: rec.openid || '',                      // 멤버 고유 ID(닉 변경/탈퇴 무관 추적)
                syncLv: syncLv,                                // 싱크로 레벨
                boss: boss,
                element: (rec.element_id && rec.element_id[0]) || '', // 보스 속성(100001~500001)
                bossId: rec.boss_id || '',
                iconId: rec.icon_id || '',                     // 보스 이미지 키
                level: rec.level || 0,                         // 보스 단계(1~10)
                isFinalHit: !!rec.is_final_hit,                // 막타 여부
                totalDamage: Number(rec.total_damage) || 0,    // GetUnionRaidData(진행 중)는 문자열로 줌 → 숫자 통일
                chars: chars,
                levels: levels,
                breaks: breaks,
                squadRaw: JSON.stringify(rec.squad || [])
            });
        }
        return out;
    }

    // ==================================================================================
    // [수집 + 전송]
    // ==================================================================================

    function fetchSeason(seasonId) {
        return originalFetch(API_URL, {
            method: 'POST',
            credentials: 'include', // 로그인 쿠키 자동 포함
            headers: {
                'content-type': 'application/json',
                'x-channel-type': '2',
                'x-language': 'ko',
                'x-common-params': X_COMMON_PARAMS
            },
            body: JSON.stringify({ area_id: AREA_ID, guild_id: GUILD_ID, season_id: String(seasonId) })
        }).then(function (r) { return r.json(); });
    }

    // 진행 중 시즌 활성 호출 — 페이지와 동일한 GetUnionRaidData(시즌 미지정=현재 시즌).
    // intl_open_id는 GetUserInfoNew에서 1회 획득해 캐시. 형식 "29080-9583…" → 앞 게임 prefix 떼고 숫자만.
    var intlOpenIdCache = '';
    function fetchIntlOpenId() {
        if (intlOpenIdCache) return Promise.resolve(intlOpenIdCache);
        return originalFetch(USER_INFO_URL, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'content-type': 'application/json',
                'x-channel-type': '2',
                'x-language': 'ko',
                'x-common-params': X_COMMON_PARAMS
            },
            body: '{}'
        }).then(function (r) { return r.json(); }).then(function (json) {
            var raw = json && json.data && json.data.info && json.data.info.intl_openid;
            var id = raw ? String(raw).replace(/^\d+-/, '') : '';
            if (id) intlOpenIdCache = id;
            else console.warn('[유레싱크] intl_open_id를 못 얻음(' + responseHint(json) + ') — 진행 중 시즌 호출은 빈 값으로 시도');
            return id;
        }).catch(function () { return ''; });
    }

    function fetchCurrentSeason(nameMap, currentSid, maxSid) {
        return Promise.all([fetchIntlOpenId(), currentSid ? Promise.resolve(currentSid) : currentSeasonId()]).then(function (pair) {
            var openId = pair[0];
            var sid = pair[1] || (knownMax ? knownMax + 1 : 0); // 시즌표 불가 시 마지막 정산 시즌+1로 귀속
            if (!sid) { console.warn('[유레싱크] 현재 시즌 번호를 정하지 못해 진행 중 시즌 호출 생략'); return []; }
            if (maxSid && sid > maxSid) {
                console.log('[유레싱크] 진행 중 시즌 ' + (sid - 1000000) + '차는 시즌 탐색 범위 ' + (maxSid - 1000000) + '차를 넘어 생략');
                return [];
            }
            return originalFetch(CURRENT_API_URL, {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'content-type': 'application/json',
                    'x-channel-type': '2',
                    'x-language': 'ko',
                    'x-common-params': X_COMMON_PARAMS
                },
                body: JSON.stringify({ guild_id: GUILD_ID, nikke_area_id: AREA_ID, intl_open_id: openId })
            }).then(function (r) { return r.json(); }).then(function (json) {
                var recs = normalize(json, sid, nameMap);
                if (recs.length) console.log('[유레싱크] 진행 중 시즌 ' + (sid - 1000000) + '차(GetUnionRaidData): ' + recs.length + '건');
                else console.log('[유레싱크] 진행 중 시즌 ' + (sid - 1000000) + '차: 기록 없음 (' + responseHint(json) + ')');
                return recs;
            });
        }).catch(function (e) {
            console.warn('[유레싱크] 진행 중 시즌 호출 실패(라이브 캡처로 보완됨)', e);
            return [];
        });
    }

    // 진행 중 보스 단계별 HP — GetUnionRaidLevelInfo(GetUnionRaidData와 같은 body).
    // level_info[] = { difficulty, level, boss_info[5] }, boss_info[].max_hp/current_hp는 문자열.
    // ⚠️ boss_info 배열 순서는 step 순서와 다름 → 보스 이름(클린)으로 GAS에서 매칭.
    function fetchBossLevels(currentSid, maxSid) {
        return Promise.all([fetchIntlOpenId(), currentSid ? Promise.resolve(currentSid) : currentSeasonId()]).then(function (pair) {
            var sid = pair[1] || (knownMax ? knownMax + 1 : 0);
            if (!sid) return null;
            if (maxSid && sid > maxSid) return null;
            return originalFetch(LEVEL_API_URL, {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'content-type': 'application/json',
                    'x-channel-type': '2',
                    'x-language': 'ko',
                    'x-common-params': X_COMMON_PARAMS
                },
                body: JSON.stringify({ guild_id: GUILD_ID, nikke_area_id: AREA_ID, intl_open_id: pair[0] })
            }).then(function (r) { return r.json(); }).then(function (json) {
                var li = json && json.data && json.data.level_info;
                if (!Array.isArray(li) || !li.length) return null;
                var entries = [];
                li.forEach(function (lv) {
                    (lv.boss_info || []).forEach(function (b) {
                        entries.push({
                            difficulty: lv.difficulty || 0,
                            level: lv.level || 0,
                            boss: cleanBoss(b.name_localvalues ? b.name_localvalues.ko : ''),
                            maxHp: Number(b.max_hp) || 0,
                            currentHp: Number(b.current_hp) || 0,
                            elementId: (b.element_id && b.element_id[0]) || '',
                            bossId: b.boss_id || '',
                            iconId: b.icon_id || ''
                        });
                    });
                });
                if (!entries.length) return null;
                console.log('[유레싱크] 보스 단계HP ' + entries.length + '건 (시즌 ' + (sid - 1000000) + '차, 난이도/단계 ' + li.map(function (l) { return l.difficulty + '/' + l.level; }).join(' ') + ')');
                return { season: sid - 1000000, entries: entries };
            });
        }).catch(function (e) {
            console.warn('[유레싱크] 보스 단계HP 조회 실패(레이드 기록 전송은 계속)', e);
            return null;
        });
    }

    function guildMembersCount(json) {
        var items = (json && json.data && json.data.items) || (json && json.items) || [];
        return Array.isArray(items) ? items.length : 0;
    }
    function fetchGuildMembers() {
        return originalFetch(GUILD_MEMBERS_URL, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'content-type': 'application/json',
                'x-channel-type': '2',
                'x-language': 'ko',
                'x-common-params': X_COMMON_PARAMS
            },
            body: JSON.stringify({ guild_id: GUILD_ID, nikke_area_id: AREA_ID })
        }).then(function (r) { return r.json(); }).then(function (json) {
            var n = guildMembersCount(json);
            if (n) console.log('[유레싱크] 현재 길드원 ' + n + '명');
            else console.warn('[유레싱크] 현재 길드원 목록이 비어 있습니다.');
            return json;
        }).catch(function (e) {
            console.warn('[유레싱크] GetGuildMembers 호출 실패(레이드 기록 전송은 계속)', e);
            return null;
        });
    }
    function responseHint(json) {
        var bits = [];
        if (!json) return '응답 없음';
        if (json.code !== undefined) bits.push('code=' + json.code);
        if (json.msg) bits.push('msg=' + json.msg);
        if (json.message) bits.push('message=' + json.message);
        try {
            if (json.data) bits.push('dataKeys=' + Object.keys(json.data).join(','));
            if (json.data && Array.isArray(json.data.participate_data)) bits.push('participate_data=' + json.data.participate_data.length);
        } catch (e) {}
        return bits.length ? bits.join(' ') : '응답 구조 미상';
    }

    function parseSeasonLimit(v) {
        var s = String(v == null ? '' : v).replace(/[^\d]/g, '');
        var n = Math.floor(Number(s) || 0);
        return n > 0 ? n : 0;
    }
    function seasonLimitSid() {
        return SEASON_LIMIT > 0 ? 1000000 + SEASON_LIMIT : 0;
    }
    function seasonRangeLabel() {
        return SEASON_LIMIT > 0 ? (SEASON_LIMIT + '차까지') : '전체(자동 탐색)';
    }
    function historicalLimitSid(currentSid, limitSid) {
        if (!limitSid) return 0;
        if (currentSid && limitSid >= currentSid) return currentSid - 1; // 진행 중 시즌은 GetUnionRaidData로 별도 수집
        return limitSid;
    }

    // 시즌 자동 탐색
    //  - 첫 실행은 START부터 올라가되, 빈 시즌이 나와도 일정 개수까지는 계속 탐색.
    //  - 이후에는 knownMax+1까지만 매 주기 확인해 새 차수를 빠르게 감지.
    //  - 이미 데이터 시즌을 찾은 다음 실행부터는 미래 시즌을 1개만 확인해 불필요한 API 부하를 막음.
    function collectAllSeasons(nameMap, cycleNum, maxClosedSid) {
        var all = [];
        var sid = START_SEASON_ID;
        var initialDiscovery = !knownMax;
        var emptyStreak = 0;
        var probeBeyond = (knownMax === 0) || (cycleNum % PROBE_NEW_EVERY === 0);
        var hardTop = START_SEASON_ID + MAX_SEASON_PROBE;
        var autoTop = probeBeyond
            ? (knownMax ? Math.min(knownMax + 1, hardTop) : hardTop)
            : knownMax;
        var topSid = maxClosedSid ? Math.min(autoTop, maxClosedSid) : autoTop;
        if (topSid < START_SEASON_ID) return Promise.resolve(all);
        console.log('[유레싱크] 시즌 탐색 범위: ' + (START_SEASON_ID - 1000000) + '~' + (topSid - 1000000) + '차' + (knownMax ? ' (다음 차수 확인 포함)' : ' (초기 탐색, 빈 차수 ' + INITIAL_EMPTY_SEASON_TOLERANCE + '회 허용)'));

        function step() {
            if (sid > topSid) return Promise.resolve(all);
            return fetchSeason(sid).then(function (json) {
                if (DEBUG_DUMP_RAW && !debugDumped) {
                    debugDumped = true;
                    try {
                        console.log('[유레싱크][DEBUG] data 키:', Object.keys((json && json.data) || {}));
                        console.log('[유레싱크][DEBUG] 첫 기록 전체:', JSON.stringify(((json.data || {}).participate_data || [])[0], null, 2));
                    } catch (e) {}
                }
                var recs = normalize(json, sid, nameMap);
                if (!recs.length) {
                    emptyStreak++;
                    if (initialDiscovery && emptyStreak < INITIAL_EMPTY_SEASON_TOLERANCE) {
                        console.log('[유레싱크] 시즌 ' + (sid - 1000000) + ': 데이터 없음 (' + responseHint(json) + ') → 계속 탐색 (' + emptyStreak + '/' + INITIAL_EMPTY_SEASON_TOLERANCE + ')');
                        sid++; return step();
                    }
                    console.log('[유레싱크] 시즌 ' + (sid - 1000000) + ': 데이터 없음 (' + responseHint(json) + ') → 탐색 종료');
                    return all; // 빈 시즌 = 다음 차수 미오픈
                }
                emptyStreak = 0;
                all = all.concat(recs);
                if (sid > knownMax) knownMax = sid; // 최대 데이터 시즌 갱신
                console.log('[유레싱크] 시즌 ' + (sid - 1000000) + ': ' + recs.length + '건');
                sid++; return step();
            }).catch(function (e) {
                console.warn('[유레싱크] 시즌 ' + (sid - 1000000) + ' 호출 실패 → 탐색 종료', e);
                return all; // 첫 실패에서 멈춤(다음 주기에 dedup으로 복구)
            });
        }
        return step();
    }

    var running = false;
    var cycle = 0;
    var knownMax = 0;        // 마지막으로 데이터가 있던 season_id (0=미발견). ban 방지용 탐색 상한
    var debugDumped = false; // DEBUG_DUMP_RAW 1회만 출력

    function runOnce(scopeOverride) {
        if (running) { console.log('[유레싱크] 이전 동기화가 아직 진행 중 — 이번 차례 건너뜀'); return; }
        if (!GAS_URL || GAS_URL.indexOf('PASTE') !== -1) {
            console.error('[유레싱크] GAS_URL을 설정하세요 (우측 패널에 웹앱 URL 입력 후 [설정 저장]).');
            return;
        }
        if (!GUILD_ID || GUILD_ID.indexOf('PASTE') !== -1) {
            console.error('[유레싱크] GUILD_ID를 설정하세요 (우측 패널에 길드 ID 입력 후 [설정 저장]).');
            return;
        }
        var scope = scopeOverride || SYNC_SCOPE;   // 'current'면 과거 시즌 자동탐색 생략(현재 시즌만)
        running = true;
        var c = ++cycle;
        var t0 = Date.now();
        console.log('[유레싱크] ⏱ #' + c + ' 동기화 시작 ' + new Date().toLocaleTimeString());

        buildNameMap().then(function (nameMap) {
            var mapSize = Object.keys(nameMap).length;
            if (!mapSize) console.warn('[유레싱크] 캐릭터 매핑을 못 구했습니다(이름이 Unknown으로 들어갈 수 있음).');

            var maxSid = (scope === 'current') ? 0 : seasonLimitSid();
            return currentSeasonId().catch(function () { return 0; }).then(function (curSid) {
                var histMaxSid = historicalLimitSid(curSid, maxSid);
                var seasonsTask = (scope === 'current') ? Promise.resolve([]) : collectAllSeasons(nameMap, c, histMaxSid);
                var currentTask = fetchCurrentSeason(nameMap, curSid, maxSid);
                var bossLevelsTask = fetchBossLevels(curSid, maxSid);
                return Promise.all([seasonsTask, fetchGuildMembers(), currentTask, bossLevelsTask]).then(function (pair) {
                    var all = (pair[0] || []).concat(pair[2] || []);
                    var guildMembers = pair[1] || null;
                    var bossLevels = pair[3] || null;
                    // 라이브 캡처분 합류 — 진행 중 시즌(활성 API가 빈 응답인 구간)의 유일한 공급원.
                    // 활성 수집과 겹치는 종료 시즌 기록은 GAS dedup이 걸러줌. 시즌 상한이 있으면 그보다 큰 캡처분은 보내지 않는다.
                    Object.keys(liveRaidBuf).forEach(function (sidStr) {
                        var sid = Number(sidStr);
                        if (maxSid && sid > maxSid) return;
                        var recs = normalize({ data: { participate_data: liveRaidBuf[sidStr].recs } }, sid, nameMap);
                        if (recs.length) {
                            all = all.concat(recs);
                            console.log('[유레싱크] 라이브 캡처 시즌 ' + (sid - 1000000) + '차 ' + recs.length + '건 합류');
                        }
                    });
                    if (!all.length && !guildMembersCount(guildMembers) && !bossLevels) {
                        console.warn('[유레싱크] 보낼 데이터가 없습니다(로그인/길드/시즌 확인).');
                        return;
                    }
                    var payload = { records: all, charMap: nameMap };
                    // 진행 중(라이브) 시즌 번호 → GAS가 그 시즌 행을 전체 교체(공격 최신→과거 순서 보존). 종료 시즌은 종전대로 append.
                    var liveNums = [];
                    if (curSid) liveNums.push(curSid - 1000000);
                    Object.keys(liveRaidBuf).forEach(function (sidStr) { var sidv = Number(sidStr); if (maxSid && sidv > maxSid) return; var n = sidv - 1000000; if (liveNums.indexOf(n) < 0) liveNums.push(n); });
                    if (liveNums.length) payload.liveSeasons = liveNums;
                    if (guildMembers) payload.guildMembers = guildMembers;
                    if (bossLevels) payload.bossLevels = bossLevels;
                    if (SECRET) payload.secret = SECRET;
                    return gmPostJson(GAS_URL, JSON.stringify(payload)).then(function (res) {
                        if (res && res.ok) {
                            console.log('[유레싱크] 전송 ' + all.length + ' → 추가 ' + res.added + (res.replaced ? ', 라이브교체 ' + res.replaced : '') + ', 중복 ' + res.skipped);
                            if (res.roster && res.roster.ok) console.log('[유레싱크] LastRoster ' + res.roster.count + '명' + (res.roster.changed ? ' 갱신' : ' 유지'));
                            if (res.bossLevels && res.bossLevels.ok) console.log('[유레싱크] 보스HP 신규 ' + res.bossLevels.added + ', 갱신 ' + res.bossLevels.updated);
                            if (res._t) console.log('[유레싱크] GAS 처리 상세', res._t);
                        } else {
                            console.error('[유레싱크] GAS 응답 오류', res);
                        }
                    });
                });
            });
        }).catch(function (e) {
            console.error('[유레싱크] runOnce 실패', e);
        }).then(function () {
            running = false;
            var sec = ((Date.now() - t0) / 1000).toFixed(1);
            console.log('[유레싱크] ✔ #' + c + ' 완료 (' + sec + '초)' + (AUTO_ON ? (' · 다음 예정 ' + new Date(Date.now() + SYNC_INTERVAL_MS).toLocaleTimeString()) : ''));
            uiRefresh();
        });
    }
    w.__ureSyncNow = runOnce;
    w.__ureLiveStatus = function () {
        var sids = Object.keys(liveRaidBuf);
        if (!sids.length) { console.log('[유레싱크] 라이브 캡처 없음 — 유레 페이지(일/boss 탭)를 열거나 새로고침하면 잡힙니다.'); return null; }
        sids.forEach(function (sidStr) {
            console.log('[유레싱크] 라이브 캡처 시즌 ' + (Number(sidStr) - 1000000) + '차: ' + liveRaidBuf[sidStr].recs.length + '건 보유');
        });
        return liveRaidBuf;
    };
    w.__ureProbeSeason = function (season) {
        var sid = Number(season);
        if (!sid) { console.warn('[유레싱크] __ureProbeSeason(41)처럼 차수를 넣어주세요.'); return Promise.resolve(null); }
        if (sid < 1000000) sid += 1000000;
        return buildNameMap().then(function (nameMap) {
            return fetchSeason(sid).then(function (json) {
                var recs = normalize(json, sid, nameMap);
                console.log('[유레싱크] 수동 시즌 확인 ' + (sid - 1000000) + '차: ' + responseHint(json) + ', 정규화 ' + recs.length + '건');
                if (recs[0]) console.log('[유레싱크] 수동 시즌 첫 기록', recs[0]);
                return { json: json, records: recs };
            });
        }).catch(function (e) {
            console.error('[유레싱크] 수동 시즌 확인 실패', e);
            return null;
        });
    };

    // ==================================================================================
    // [자동 타이머 제어] — 패널 ON/OFF·간격 변경 시 재설정
    // ==================================================================================
    var autoTimer = null, nextRunAt = 0;
    function startAuto() {
        if (autoTimer) clearInterval(autoTimer);
        nextRunAt = Date.now() + SYNC_INTERVAL_MS;
        autoTimer = setInterval(function () { nextRunAt = Date.now() + SYNC_INTERVAL_MS; runOnce(); }, SYNC_INTERVAL_MS);
        AUTO_ON = true; uiRefresh();
    }
    function stopAuto() {
        if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
        nextRunAt = 0; AUTO_ON = false; uiRefresh();
    }

    // ==================================================================================
    // [GUI 패널] — 설정 입력·저장(GM_setValue)·수동 동기화·상태 로그. 코드 수정 불필요.
    // ==================================================================================
    var ui = {};   // 패널 DOM 참조
    function uiLog(msg, level) {
        if (!ui.log) return;
        var line = document.createElement('div');
        line.textContent = msg;
        line.style.cssText = 'padding:1px 0;white-space:pre-wrap;word-break:break-all;' +
            (level === 'error' ? 'color:#ff8a8a' : level === 'warn' ? 'color:#ffd479' : 'color:#cfe3ff');
        ui.log.appendChild(line);
        while (ui.log.childNodes.length > 120) ui.log.removeChild(ui.log.firstChild);
        ui.log.scrollTop = ui.log.scrollHeight;
    }
    function uiRefresh() {
        if (!ui.status) return;
        var bits = ['자동갱신 ' + (AUTO_ON ? 'ON' : 'OFF'), (SYNC_INTERVAL_MS / 60000) + '분', seasonRangeLabel()];
        if (AUTO_ON && nextRunAt) bits.push('다음 ' + new Date(nextRunAt).toLocaleTimeString());
        ui.status.textContent = bits.join(' / ');
        if (ui.autoBtn) { ui.autoBtn.textContent = AUTO_ON ? '자동갱신 끄기' : '자동갱신 켜기'; ui.autoBtn.style.background = AUTO_ON ? '#2c6e49' : '#5a3d3d'; }
    }
    function uiSaveSettings() {
        var url = ui.url.value.trim(), guild = ui.guild.value.trim();
        var min = Math.max(1, Number(ui.interval.value) || (SYNC_INTERVAL_MS / 60000));
        var limit = parseSeasonLimit(ui.seasonLimit.value);
        GAS_URL = url || GAS_URL; SECRET = ui.secret.value.trim(); GUILD_ID = guild || GUILD_ID;
        AREA_ID = Number(ui.area.value) || AREA_ID; SYNC_INTERVAL_MS = min * 60000; SEASON_LIMIT = limit;
        cfgSet('gasUrl', GAS_URL); cfgSet('secret', SECRET); cfgSet('guildId', GUILD_ID);
        cfgSet('areaId', String(AREA_ID)); cfgSet('intervalMin', String(min)); cfgSet('seasonLimit', limit ? String(limit) : '');
        if (AUTO_ON) startAuto();   // 간격이 바뀌었을 수 있으니 타이머 재설정
        uiRefresh();
        console.log('[유레싱크] 설정 저장됨 (간격 ' + min + '분 / ' + seasonRangeLabel() + ')');
    }
    function uiToggleAuto() {
        if (AUTO_ON) { stopAuto(); cfgSet('autoOn', '0'); console.log('[유레싱크] 자동갱신 OFF'); }
        else { startAuto(); cfgSet('autoOn', '1'); console.log('[유레싱크] 자동갱신 ON (' + (SYNC_INTERVAL_MS / 60000) + '분 간격)'); }
    }
    function mkInput(label, value, ph) {
        var wrap = document.createElement('label');
        wrap.style.cssText = 'display:block;margin:5px 0;font-size:11px;color:#9fb0c8';
        wrap.textContent = label;
        var inp = document.createElement('input');
        inp.value = (value == null) ? '' : value;
        if (ph) inp.placeholder = ph;
        inp.style.cssText = 'width:100%;box-sizing:border-box;margin-top:2px;padding:5px 6px;border:1px solid #3a4a63;border-radius:6px;background:#0f1626;color:#e6edf7;font:inherit;font-size:12px';
        wrap.appendChild(inp);
        return { wrap: wrap, input: inp };
    }
    function mkSelect(label, value, options) {
        var wrap = document.createElement('label');
        wrap.style.cssText = 'display:block;margin:5px 0;font-size:11px;color:#9fb0c8';
        wrap.textContent = label;
        var sel = document.createElement('select');
        sel.style.cssText = 'width:100%;box-sizing:border-box;margin-top:2px;padding:5px 6px;border:1px solid #3a4a63;border-radius:6px;background:#0f1626;color:#e6edf7;font:inherit;font-size:12px';
        options.forEach(function (opt) {
            var o = document.createElement('option');
            o.value = String(opt.value);
            o.textContent = opt.label;
            sel.appendChild(o);
        });
        sel.value = String(value || 83);
        wrap.appendChild(sel);
        return { wrap: wrap, input: sel };
    }
    function mkBtn(text, bg, fn) {
        var b = document.createElement('button');
        b.textContent = text; b.type = 'button';
        b.style.cssText = 'flex:1;min-width:0;padding:6px 4px;border:0;border-radius:6px;background:' + bg + ';color:#fff;font:inherit;font-size:12px;font-weight:600;cursor:pointer';
        b.addEventListener('click', fn);
        return b;
    }
    function buildPanel() {
        if (ui.box || !document.body) return;
        var placeholderUrl = (GAS_URL.indexOf('PASTE') !== -1) ? '' : GAS_URL;
        var placeholderGuild = (GUILD_ID.indexOf('PASTE') !== -1) ? '' : GUILD_ID;
        var box = document.createElement('div');
        box.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483647;width:300px;max-width:92vw;' +
            'background:#141c2b;border:1px solid #2a3854;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.5);' +
            'font-family:Malgun Gothic,Segoe UI,sans-serif;color:#e6edf7;padding:11px 12px';
        // 헤더(제목 + 접기)
        var head = document.createElement('div');
        head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:4px';
        var title = document.createElement('b'); title.textContent = '유레 기록 자동 수집기'; title.style.cssText = 'font-size:13px';
        var fold = mkBtn('—', '#33415c', function () {
            var hidden = ui.body.style.display === 'none';
            ui.body.style.display = hidden ? 'block' : 'none'; fold.textContent = hidden ? '—' : '+';
        });
        fold.style.cssText = 'width:26px;flex:0 0 auto;padding:2px 0;border:0;border-radius:6px;background:#33415c;color:#fff;cursor:pointer;font-weight:700';
        head.appendChild(title); head.appendChild(fold);
        box.appendChild(head);
        // 본문
        var body = document.createElement('div'); ui.body = body; box.appendChild(body);
        var url = mkInput('웹앱 URL (…/exec)', placeholderUrl, 'https://script.google.com/.../exec'); ui.url = url.input; body.appendChild(url.wrap);
        var secret = mkInput("SECRET (Code.gs의 'SECRET' 값과 일치 해야합니다)", SECRET, '비워두면 미사용'); ui.secret = secret.input; body.appendChild(secret.wrap);
        var guild = mkInput('길드 ID', placeholderGuild, '본인 길드 ID(숫자)'); ui.guild = guild.input; body.appendChild(guild.wrap);
        var area = mkSelect('지역 ID', AREA_ID, [
            { value: 83, label: '한국 서버 (83)' },
            { value: 81, label: '일본 서버 (81)' },
            { value: 82, label: '북미 서버 (82)' },
            { value: 84, label: '글로벌 서버 (84)' },
            { value: 85, label: '동남아 서버 (85)' }
        ]); ui.area = area.input; body.appendChild(area.wrap);
        // 간격 + 범위 한 줄
        var row1 = document.createElement('div'); row1.style.cssText = 'display:flex;gap:8px';
        var interval = mkInput('자동 간격(분)', (SYNC_INTERVAL_MS / 60000), '5'); ui.interval = interval.input; interval.wrap.style.flex = '1'; row1.appendChild(interval.wrap);
        var seasonLimit = mkInput('시즌 탐색 범위', SEASON_LIMIT || '', '미 입력시 전체(자동 탐색)'); ui.seasonLimit = seasonLimit.input; seasonLimit.wrap.style.flex = '1'; row1.appendChild(seasonLimit.wrap);
        body.appendChild(row1);
        // 버튼들
        var btnRow1 = document.createElement('div'); btnRow1.style.cssText = 'display:flex;gap:6px;margin-top:8px';
        btnRow1.appendChild(mkBtn('설정 저장', '#3a6df0', uiSaveSettings));
        ui.autoBtn = mkBtn('자동갱신', '#2c6e49', uiToggleAuto); btnRow1.appendChild(ui.autoBtn);
        body.appendChild(btnRow1);
        var btnRow2 = document.createElement('div'); btnRow2.style.cssText = 'display:flex;gap:6px;margin-top:6px';
        btnRow2.appendChild(mkBtn('현재 시즌 1회', '#33415c', function () { runOnce('current'); }));
        btnRow2.appendChild(mkBtn('시즌 범위 1회', '#33415c', function () { runOnce('all'); }));
        body.appendChild(btnRow2);
        // 상태 + 로그
        var status = document.createElement('div'); ui.status = status; status.style.cssText = 'margin:9px 0 5px;font-size:11px;color:#ffd479;font-weight:600'; body.appendChild(status);
        var log = document.createElement('div'); ui.log = log; log.style.cssText = 'height:120px;overflow:auto;background:#0b111d;border:1px solid #243049;border-radius:8px;padding:6px 7px;font-size:11px;line-height:1.45'; body.appendChild(log);
        document.body.appendChild(box); ui.box = box;
        uiRefresh();
        if (GAS_URL.indexOf('PASTE') !== -1 || GUILD_ID.indexOf('PASTE') !== -1) uiLog('웹앱 URL과 길드 ID를 입력하고 [설정 저장]을 누르세요.', 'warn');
    }

    // [유레싱크] 콘솔 로그를 패널에도 미러링(기존 console 호출은 그대로 둠)
    ['log', 'warn', 'error'].forEach(function (k) {
        var orig = console[k] ? console[k].bind(console) : function () {};
        console[k] = function () {
            orig.apply(null, arguments);
            try { var s = arguments[0]; if (typeof s === 'string' && s.indexOf('[유레싱크') === 0) uiLog(s, k); } catch (e) {}
        };
    });

    // ==================================================================================
    // [기동]
    // ==================================================================================

    window.addEventListener('load', function () {
        buildPanel();
        setTimeout(function () { if (AUTO_ON) runOnce(); }, FIRST_RUN_DELAY_MS);
        if (AUTO_ON) startAuto();
    });

    console.log('[유레싱크] 로드됨. 시작시즌 ' + (START_SEASON_ID - 1000000) + '차+ / ' + seasonRangeLabel() + ' / ' + (SYNC_INTERVAL_MS / 60000) + '분 주기 / 진행 중 시즌은 페이지 응답 라이브 캡처');
})();
