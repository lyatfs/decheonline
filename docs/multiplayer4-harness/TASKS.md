# Task plan — Multiplayer4 và chia sẻ link

**Goal:** Chủ máy chạy server, tạo phòng4, gửi link để ba người khác vào chơi qua trình duyệt.

**Architecture:** Giữ server relay/lockstep, thêm room capacity và stable slots; link mời dùng cùng origin; production launcher tách LAN và tunnel.

**Tech stack:** Node>=24, TypeScript/npm workspaces, Vitest, Playwright, Windows launcher.

**Spec:** [CONTEXT.md](CONTEXT.md), [CONTRACTS.md](CONTRACTS.md). Các task đều TODO; manifest máy đọc nằm trong [tasks.json](tasks.json).

## Cách thực hiện mỗi task

- [ ] Đọc context, contracts frozen, AGENTS và mã tại baseline được giao; ghi git status và quyền sở hữu file.
- [ ] Viết test fail đúng hành vi thiếu/lỗi; chạy để thấy fail vì nguyên nhân đó.
- [ ] Implement phạm vi nhỏ nhất; tái sử dụng code đúng, không viết lại subsystem.
- [ ] Chạy test liên quan + kiểm tra tĩnh phù hợp; ghi command/exit code/pass/fail/skip.
- [ ] Reviewer đọc diff và yêu cầu; fix lỗi mức cao rồi retest; tích hợp có kiểm tra.

Không tự commit/push/deploy. Harness chỉ dispatch khi dependencies DONE và hợp đồng có trên baseline chung. Task owner chỉ sửa write_globs trong manifest; file khác phải xin lock orchestrator.

Ngoại lệ kiểm thử: M00 và phần audit/tài liệu không đổi hành vi dùng baseline/design evidence, không tạo lỗi giả để có test đỏ. Với hành vi đã có đúng, ghi regression/characterization thực và giữ implementation; chỉ thay đổi hành vi mới hoặc bugfix cần chu trình đỏ→xanh.

<a id="m00"></a>

## M00 — Baseline, contract freeze và thiết kế phòng

**Owner:** architect/orchestrator. **Deps:** không. **Files:** docs bộ harness, protocol types draft trong tài liệu; chưa sửa logic game.

Chạy baseline, kiểm kê assumptions2; chốt C01–C06, compatibility message defaults, lifecycle/termination, token handling, schema/public APIs cho room/launcher/invite/version endpoint. Đóng băng contract và test fixtures chia sẻ. Kiểm tra map BASES trước khi kết luận cần sửa.

**Tests:** X01–X03. **Done:** có baseline evidence, contract version frozen, API exact và ownership/port locks; không còn design bắt downstream tự đoán.

<a id="m01"></a>

## M01 — Protocol capacity, slots, manifest và versions

**Owner:** protocol. **Deps:** M00. **Files:** `packages/protocol/src/messages.ts`, `codec.ts`, `index.test.ts` và test mới trong cùng package.

Thêm capacity2/4 mặc định2, room snapshot đủ slots/hostSlot, immutable start manifest/version identifiers, validation slot/recipient0..3 và new result-report nếu frozen contract yêu cầu. Giữ create cũ và single-player. Chỉ types/codec, không sửa rooms.

**Tests:** C01–C04, V03. **Done:** wire examples round-trip, reject dữ liệu sai, typecheck đủ caller hoặc adapter chuyển tiếp có chủ đích; không ép mọi test cũ sang phòng4. Chặn mismatch trên server thuộc M02; toàn luồng client thuộc M10.

<a id="m02"></a>

## M02 — Room membership, capacity và host role

**Owner:** room-model. **Deps:** M01. **Files:** `apps/server/src/room-seats.ts` + tests; tích hợp `rooms.ts`, `relay.test.ts` trong lock `server-room`.

Slot cố định; join ghế trống nhỏ nhất, capacity riêng theo mode; ready/start đúng2/4; hostSlot authoritative chuyển role khi host rời, không đổi identity. Không splice làm đổi slot. Dùng helper/mô hình mới thay assumptions array index có kiểm soát.

**Tests:** R01–R05, V04. **Done:** phòng4 không start với3; fifth join fail không mutation; single-player vẫn 2; không mất ready/civ/role sai khi thay membership. Validate version ở boundary server bằng version authority/config đã chốt ở M00; M11 nối metadata production thật.

<a id="m03"></a>

## M03 — Turn release, RTT, checksum và rejoin bốn người

**Owner:** netcode. **Deps:** M02. **Files:** `apps/server/src/rooms.ts`, `speed.ts`, relay/speed tests; `apps/client/src/lockstep/lockstep.ts` và tests trong lock `lockstep`.

Release đủ active senders, thứ tự batch ổn định; G/F từ thành viên liên quan, không chờ người dropped; rejoin phát lại thiếu một lần; checksum chờ đủ mẫu đúng turn rồi so. Không sửa CTI hay pacing để chữa triệu chứng.

**Tests:** N01–N05. **Done:** bốn fake peers đạt cùng turn/hash, delay một peer không bỏ lệnh và reconnect không đổi slot/civ.

<a id="m04"></a>

## M04 — Resign/drop/leave và match termination

**Owner:** lifecycle. **Deps:** M03. **Files:** rooms/relay tests cùng lock `server-room`; protocol bổ sung chỉ qua owner M01 khi cần.

Một người rời/đầu hàng không đóng trận. Inject resign đúng turn, bỏ khỏi wait set, giữ token/slot theo chính sách và không rejoin vào slot mới. Tách participant result khỏi match-finished; implement result agreement đã chốt. Host browser rời khác với server process chết.

**Tests:** L01–L05. **Done:** hai người thua/rời vẫn không chặn hai người còn chơi; last disconnect dọn room/timer; single-player pause/resign không hồi quy.

<a id="m05"></a>

## M05 — Client session và lobby bốn ghế

**Owner:** lobby. **Deps:** M01, M02. **Files:** `apps/client/src/lobby/session.ts`, `index.ts`, `lobby-view.ts`, lobby tests; không sửa single-player controller nếu chưa được cấp lock.

UI chọn capacity2/4, 4 ghế/civ/màu/ready/host role; trạng thái đầy/started; giữ inputs theo slot; server snapshot là nguồn sự thật. Client gửi đúng metadata vào Start, không nhầm hostSlot với sim player.

**Tests:** U01–U04. **Done:** UI4 ghế trên viewport nhỏ, quyền settings/start cập nhật khi đổi host; single-player và lobby2 vẫn dùng được.

<a id="m06"></a>

## M06 — Link mời và entry flow

**Owner:** invite. **Deps:** M01, M02. **Files:** `apps/client/src/lobby/invite-link.ts` + tests; view/session hook qua owner M05, main/multiplayer hook qua M10.

Parse/generate URL `?room=CODE`, nhập tên rồi join; copy link với clipboard fallback. Validate public origin/code, không tự start/ready, không serialize token. Link code người dùng gõ không trở thành script/HTML/shell input.

**Tests:** I01–I05. **Done:** module độc lập có tests và hook list chính xác; hook production được tích hợp trước khi M10 đóng, không gọi module chết là feature hoàn tất.

<a id="m07"></a>

## M07 — Simulation, map, victory và replay bốn người

**Owner:** sim/map. **Deps:** M01. **Files:** `packages/sim/src/{world,game-settings,rmm-controller,replay,victory,diplomacy}.ts` và test tương ứng theo nhu cầu.

Giữ slot+1/Gaia, bốn start distinct, đủ tài nguyên, seeded random map, ownership và free-for-all thắng đúng. Snapshot/replay/commands qua4 người. Không thêm teams2v2 trong MVP; không tăng player count bằng một hằng số mà bỏ civ/visibility arrays.

**Tests:** W01–W05. **Done:** 4human/5sim players, checksum/replay deterministic, spawn không lặp BASES; nếu logic đã hỗ trợ thì bổ sung regression thay vì sửa vô ích.

<a id="m08"></a>

## M08 — HUD, ngoại giao, màu và asset audit

**Owner:** presentation/assets. **Deps:** M01, M07. **Files:** client `hud/` tests, audit helper `tools/assets-import/src/multiplayer-audit.ts` + tests; asset writers chỉ sửa khi có bug đã xác nhận.

Bảng điểm/minimap/chat recipient/diplomacy đủ4; phân màu0Gaia/1..4players đúng. Audit manifest/file tồn tại, graphic refs, frame limits và version/data identity. Phân loại unused/null/fallback đúng. Không tự sửa file binary/pack gốc hoặc generated tables; tạo báo cáo thiếu cụ thể.

**Tests:** H01–H04, V02. **Done:** UI4 hoạt động; asset audit đủ owner1..4 của graphic thực dùng và báo rõ thiếu gì, không tuyên bố art ready nếu thiếu.

<a id="m09"></a>

## M09 — Production host launcher cho LAN

**Owner:** host tooling. **Deps:** M00. **Files:** `tools/host/` mới, `Chay-May-Chu.cmd`, `docs/multiplayer4-hosting.md`; package scripts/config server chỉ qua M11.

Start/status/stop một serverproduction; nhận port/path, kiểm tra runtime/build/assets, chọn IP LAN, chờ health, hiển thị URL và log. Không cần mở source editor. Dừng chỉ child process đã tạo; hỗ trợ chạy từ thư mục khác, đường dẫn Unicode/spaces và port bận.

M00 chốt API/config/module names và status output cho M11/M12. M09 có thể dùng fixture preflight để phát triển; **không được tuyên bố launcher dùng thật trước M11 tích hợp**.

**Tests:** O01–O04. **Done:** helper/launcher có bằng chứng process lifecycle, lỗi rõ, không đóng nhầm chương trình khác; docs phân biệt host máy và host phòng. O05 cần game tích hợp nên nghiệm thu trong M13.

<a id="m10"></a>

## M10 — Client integration và version gate

**Owner:** integrator client. **Deps:** M03, M04, M05, M06, M07, M08, M11.

**Files:** `apps/client/src/multiplayer.ts`, `main.ts`, `net/link.ts`, `e2e/globals.d.ts`; nối invite/view theo lock cấp lại từ M05/M06.

Nối slots/civs/hostSlot/mode/version vào World và HUD, link thật vào entry/session, xử lý mismatch trước Ready/Start. Cùng-origin `/ws` hoạt động trên LAN/tunnel, không localhost cứng. Các hook cần để test phải có type và không lộ token.

**Tests:** U05, I06, V01, N06. **Done:** các module M05/M06/M08 đi vào user flow thật; bốn client spawn đúng người, legacy single-player unchanged.

<a id="m11"></a>

## M11 — Server hosting integration và packaging

**Owner:** integrator server/tooling. **Deps:** M04, M08, M09.

**Files:** `apps/server/src/{app,assets,main}.ts`, server app tests, root `package.json`/lock khi thực sự cần, `tools/host/` nối launcher dưới lock cấp lại.

Nối health/readiness/version metadata theo contract; không trả secrets/IP nội bộ không cần thiết. Đồng bộ launcher env paths, build output, asset checks, start/log/stop. Không tự install dependencies ở mỗi lần host và không chạy Vite dev làm distribution.

**Tests:** O06, V02. **Done:** launcher production truy cập được LAN ở mức cấu hình, readiness chỉ ready khi đủ file/version; không chỉ mock child spawn. Version endpoint/identity khớp authority M02; UI mismatch toàn luồng được kiểm tra ở M10/M13.

<a id="m12"></a>

## M12 — Link Internet qua tunnel opt-in

**Owner:** tunnel tooling. **Deps:** M11.

**Files:** `tools/host/tunnel.ts`/adapter + tests theo API frozen, docs hosting; launcher hook qua lock cấp từ M11.

Gắn tunnel lifecycle, nhận public URL validate, hiển thị trạng thái tạm/cố định, copy link; WebSocket và HTTP cùng origin; reconnect khi transport bị cắt. Không log token, không shell-eval output, không tự đổi DNS/firewall/router hoặc chạy binary không rõ nguồn. API provider được kiểm tra với docs chính thức khi triển khai, không tin cú pháp cũ trong context.

**Tests:** O07–O08. **Done:** fixture tunnel kiểm thử tự động; không phụ thuộc mạng ngoài để cho M13 chạy local. O09 bắt buộc ở M14/A09. Token/account provisioning nếu cần là việc người dùng cấp, không giả lập thành đã deploy.

<a id="m13"></a>

## M13 — Bốn client end-to-end và non-regression

**Owner:** QA integration. **Deps:** M10, M11, M12.

**Files:** `e2e/tests/multiplayer4-*.spec.ts`, helpers riêng; e2e shared config/globals chỉ qua integrator khi cần.

Tạo room4, ba khách qua link, Ready/Start; lệnh bốn phía, hash same-turn, fifth denied, drop/rejoin/resign, host-role transfer. Legacy room2 và single-player, pause/speed cũ đều đạt. Synthetic tests độc lập asset thật; không đổi fixtures toàn suite để làm4 pass nhưng phá2.

**Tests:** A01–A05, O05. **Done:** có logs/artifact cho lỗi mạng và kết quả thật; một job sở hữu ports.

<a id="m14"></a>

## M14 — Soak, test thực địa và bàn giao

**Owner:** reviewer/QA độc lập. **Deps:** M13.

**Files:** `docs/multiplayer4-acceptance.md`, test soak4/helper nếu cần; không sửa product logic khi đang giữ vai trò review.

Chạy check/build, seeded soak4 có đủ hành vi khác nhau, cross-engine determinism; thử LAN bốn thiết bị rồi Internet có ít nhất một client ngoài LAN, giữ process host hoạt động. Ghi versions/seed/latency/errors, CPU/RAM/băng thông quan sát được; không suy đoán sức chứa từ cấu hình máy.

**Tests:** A06–A09, O09. **Done:** report đầy đủ, hướng dẫn launch/share/stop/error; phần môi trường thiếu phải BLOCKED, không auto-DONE. Không tự publish/commit/deploy.

## Lịch chạy và locks

| Wave | Tasks | Chú ý |
|---|---|---|
| A | M00 | Freeze trước |
| B | M01 + M09 | Tooling dùng contract, chưa nối server |
| C | M02 + M07 | Room và sim độc lập sau protocol |
| D | M03 + M05 + M08 | M03 lock server-room/lockstep; M05 lock lobby |
| E | M04 + M06 | M04 thừa kế server-room; M06 chỉ invite module sau M02 |
| F | M11 rồi M10 | Nối server endpoint trước gate client/user flow thật |
| G | M12 | Tooling lock sau M11 |
| H | M13 rồi M14 | E2E/soak cùng một chủ port |

Tối đa 3 implementer + 1 orchestrator theo khả năng môi trường. Không dùng worktree để bỏ qua conflict: dependencies vẫn phải tích hợp theo thứ tự. M01 protocol owner hỗ trợ change request tuần tự, không để agent khác sửa schema chung tự phát.
