// ==UserScript==
// @name         Nikke Union Raid -> Google Sheet Sync
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  blablalink 유니온 레이드(유레) 데이터를 5분마다 자동 수집해 Google Apps Script 웹앱으로 전송. 캐릭터 매핑은 라이브 캡처 → CDN → GitHub → CharMap 계층형 폴백.
// @author       You
// @match        *://*.blablalink.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
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
    var AREA_ID = 83;    // (한국서버 83. 한섭 아니면 수정해야함 일본서버 81 북미서버 82 글로벌 서버 84 동남아 서버 85)
    var GUILD_ID = 'PASTE_YOUR_GUILD_ID_HERE';   // 반드시 본인 길드 ID (이름 옆에 숫자로 된거)로

    // 시즌 자동 탐색: START부터 위로 올라가며, 데이터 없는(또는 호출 실패) 첫 시즌에서 즉시 멈춤.
    // → 새 시즌(41차…)이 열리면 자동 포함. 보통 손댈 필요 없음.
    //   (중간에 일시적 오류로 끊겨도 다음 주기에 dedup으로 자동 복구됨)
    var START_SEASON_ID = 1000035; // 수집 시작 = 가장 오래된 시즌 (season_id = 1000000 + 시즌번호)
    var MAX_SEASON_PROBE = 80;     // 안전 상한(혹시 데이터가 안 끝날 때 무한루프 방지)
    var PROBE_NEW_EVERY = 12;      // 새 차수 탐지 주기(사이클). 평소엔 '없는 시즌'을 요청하지 않고, 이 주기마다 1회만 위로 탐색. 12 ≈ 1시간(@5분)

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

    // 레이드 API
    var API_URL = 'https://api.blablalink.com/api/game/proxy/Game/GetUnionRaidDataOfGuildSeason';
    var GUILD_MEMBERS_URL = 'https://api.blablalink.com/api/game/proxy/Game/GetGuildMembers';
    var X_COMMON_PARAMS = '{"game_id":"16","area_id":"global","source":"pc_web","intl_game_id":"29080","language":"ko","env":"prod","data_statistics_scene":"outer","data_statistics_page_id":"https://www.blablalink.com/shiftyspad","data_statistics_client_type":"pc_web","data_statistics_lang":"ko"}';

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
        } catch (e) {}
        return p;
    };

    var XHR = w.XMLHttpRequest.prototype;
    var xhrOpen = XHR.open;
    var xhrSend = XHR.send;
    XHR.open = function (method, url) { this._url = url; return xhrOpen.apply(this, arguments); };
    XHR.send = function () {
        this.addEventListener('load', function () {
            try { if (isMapUrl(this._url)) captureMap(JSON.parse(this.responseText)); } catch (e) {}
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
                totalDamage: rec.total_damage || 0,
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

    // 시즌 자동 탐색 (ban 방지: 평소엔 '없는 시즌'을 요청하지 않음)
    //  - knownMax(마지막으로 데이터가 있던 시즌)까지만 매 주기 수집.
    //  - 새 차수 탐지는 PROBE_NEW_EVERY 주기마다 1회만 그 위로 probe.
    function collectAllSeasons(nameMap, cycleNum) {
        var all = [];
        var sid = START_SEASON_ID;
        var probeBeyond = (knownMax === 0) || (cycleNum % PROBE_NEW_EVERY === 0); // 첫 사이클 or 주기적으로만 미지의 시즌 탐색
        var topSid = probeBeyond ? (START_SEASON_ID + MAX_SEASON_PROBE) : knownMax;

        function step() {
            if (sid > topSid) return Promise.resolve(all); // 평소엔 knownMax 초과 요청 안 함 → 없는 시즌 호출 X
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
                    console.log('[유레싱크] 시즌 ' + (sid - 1000000) + ': 데이터 없음 → 탐색 종료');
                    return all; // 빈 시즌 = 다음 차수 미오픈
                }
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

    function runOnce() {
        if (running) { console.log('[유레싱크] 이전 동기화가 아직 진행 중 — 이번 차례 건너뜀'); return; }
        if (!GAS_URL || GAS_URL.indexOf('PASTE') !== -1) {
            console.error('[유레싱크] GAS_URL을 설정하세요.');
            return;
        }
        if (!GUILD_ID || GUILD_ID.indexOf('PASTE') !== -1) {
            console.error('[유레싱크] GUILD_ID를 설정하세요.');
            return;
        }
        running = true;
        var c = ++cycle;
        var t0 = Date.now();
        console.log('[유레싱크] ⏱ #' + c + ' 동기화 시작 ' + new Date().toLocaleTimeString());

        buildNameMap().then(function (nameMap) {
            var mapSize = Object.keys(nameMap).length;
            if (!mapSize) console.warn('[유레싱크] 캐릭터 매핑을 못 구했습니다(이름이 Unknown으로 들어갈 수 있음).');

            return Promise.all([collectAllSeasons(nameMap, c), fetchGuildMembers()]).then(function (pair) {
                var all = pair[0] || [];
                var guildMembers = pair[1] || null;
                if (!all.length && !guildMembersCount(guildMembers)) {
                    console.warn('[유레싱크] 보낼 데이터가 없습니다(로그인/길드/시즌 확인).');
                    return;
                }
                var payload = { records: all, charMap: nameMap };
                if (guildMembers) payload.guildMembers = guildMembers;
                if (SECRET) payload.secret = SECRET;
                return gmPostJson(GAS_URL, JSON.stringify(payload)).then(function (res) {
                    if (res && res.ok) {
                        console.log('[유레싱크] 전송 ' + all.length + ' → 추가 ' + res.added + ', 중복 ' + res.skipped);
                        if (res.roster && res.roster.ok) console.log('[유레싱크] LastRoster ' + res.roster.count + '명' + (res.roster.changed ? ' 갱신' : ' 유지'));
                        if (res._t) console.log('[유레싱크] GAS 처리 상세', res._t);
                    } else {
                        console.error('[유레싱크] GAS 응답 오류', res);
                    }
                });
            });
        }).catch(function (e) {
            console.error('[유레싱크] runOnce 실패', e);
        }).then(function () {
            running = false;
            var sec = ((Date.now() - t0) / 1000).toFixed(1);
            var next = new Date(Date.now() + SYNC_INTERVAL_MS).toLocaleTimeString();
            console.log('[유레싱크] ✔ #' + c + ' 완료 (' + sec + '초) · 다음 예정 ' + next);
        });
    }

    // ==================================================================================
    // [기동]
    // ==================================================================================

    window.addEventListener('load', function () {
        setTimeout(runOnce, FIRST_RUN_DELAY_MS);
        setInterval(runOnce, SYNC_INTERVAL_MS);
    });

    console.log('[유레싱크] 로드됨. 시작시즌 ' + (START_SEASON_ID - 1000000) + '차+ 자동탐색 / ' + (SYNC_INTERVAL_MS / 60000) + '분 주기');
})();
