# Kiểm thử và quality gates — multiplayer4

Các ca này là yêu cầu cho lần triển khai sau. **Chưa chạy** trong lần tạo harness. Kiểm tra tên/spec thật trước khi gọi lệnh; filter không tìm được test không phải pass.

## Ca bắt buộc

| ID | Tình huống | Kết quả phải chứng minh |
|---|---|---|
| X01 | Baseline đúng commit, dirty tree | Ghi nhận thay đổi người dùng; không reset/clean |
| X02 | Fixture/message/API contracts | Có version frozen, exact input/output và defaults |
| X03 | Ownership, DAG và environment | Không cycle, không task chạy trước deps, không hai writer cùng file |
| C01 | Create thiếu capacity, chọn2/4, single-player | Default2; single-player2, không phải MAX_PLAYERS4 toàn cục |
| C02 | Slot/recipient3 và4, âm/fraction/NaN | Slot3 được xét trong room4; invalid bị reject, room2 không nhận slot3 |
| C03 | Snapshot lobby/start/rejoin | Slot/civ/role/version giữ đúng, không leak token |
| C04 | JSON malformed, dư recipient/batch/message quá lớn | Validation không throw, không mutation room hoặc bypass quyền |
| R01 | Join room4 tuần tự, người thứ5 | Ghế0..3 duy nhất, fifth denied không thay room |
| R02 | Start phòng4 với3 hoặc một người chưa ready | Không start; đủ4 ready mới start |
| R03 | Legacy room2 và single-player | Vẫn start với đúng2, không chờ4 |
| R04 | Host rời lobby khi có hole | Chuyển role, không đổi slot/civ người còn lại; clear ready đúng policy |
| R05 | Client không phải host gửi settings/start | Server reject dựa socket/role thật |
| N01 | Bốn peer gửi batch lệch thứ tự/thời gian | Cùng thứ tự command và turn trên cả4, không phát thiếu/nhân batch |
| N02 | Peer gửi lặp/quá xa/quá lớn | Reject hoặc dedup theo contract, không ảnh hưởng batch đã accepted |
| N03 | Một peer chậm/mất packet/kết nối | Có wait/timeout policy; sau drop không chờ nó mãi |
| N04 | Checksum chưa đủ mẫu, mẫu0, sai turn | Không kết luận desync do thiếu mẫu; divergence thật được phát hiện |
| N05 | Rejoin room4 và token sai | Slot/civ/player gốc được phục hồi, replay đúng một lần; token sai fail |
| N06 | Client initialization từ manifest | Đủ4human/5simplayers, arrays không bị compact sau drop |
| L01 | Một người resign rồi đóng tab | Ba người tiếp tục, resign đúng turn không bị mất |
| L02 | Người rời không gửi resign, hết grace period | Server đồng bộ loại đúng người, giữ identity, không close cả phòng |
| L03 | Hai người rời/đầu hàng, hai người còn | Trận tiếp tục theo victory, không dựa số2 cũ hoặc gameOver của một member |
| L04 | Client tự báo thắng sai | Không đóng phòng hoặc chấp nhận kết quả thiếu cơ chế agreement |
| L05 | Không còn kết nối, host-role đổi, single-player paused quit | Dọn timer/room đúng; role transfer không giả lập server migration; không pause deadlock cũ |
| U01 | Lobby4 và viewport390px | Đủ4 slot, thao tác civ/Ready/Start đọc và dùng được |
| U02 | Membership/settings đổi lúc đang ready | UI phản ánh snapshot đúng, không bắt đầu từ cấu hình stale |
| U03 | Host role chuyển sang slot khác0 | Nút/quyền đúng; owner/player/colour không đổi |
| U04 | Tạo room2 sau room4 và single-player | Không giữ capacity/bot/ready/autostart của phiên trước |
| U05 | Four-client start qua UI thật | Tất cả dùng seed/settings/civs/slots/version giống nhau |
| I01 | Link mời từ LAN/public origin | Có room code, không localhost hoặc token bí mật |
| I02 | Mở link, nhập tên | Chỉ join sau thao tác hợp lệ; không tự ready/start |
| I03 | Code invalid/phòng đầy/đã start/hết | Lỗi rõ và retry được, không join nhầm hoặc xóa form |
| I04 | Clipboard bị từ chối | Có cách chọn/copy link thủ công |
| I05 | URL/code có ký tự lạ, query trùng | Validator/URL API xử lý; không XSS, không shell injection |
| I06 | Link thật qua entry→session→server | Đúng phòng; helper được gọi production, không chỉ test module |
| W01 | Fixed map4 | Bốn spawn distinct, có đủ TC/dân/resource theo luật, không lặp modulo |
| W02 | Random map nhiều seed/type | Bốn vị trí hợp lệ, footprint không chồng; resource/reach hợp lý theo map type |
| W03 | Gaia và owner1..4 | Không điều khiển quân người khác, visibility/diplomacy/score đúng |
| W04 | Người3/4 chết hoặc resign, FFA victory | Chỉ kết thúc khi victory thật; người cuối thắng theo luật |
| W05 | JSON snapshot/replay4, Random civ | Cùng seed/accepted commands cho cùng checksum, không thiếu player arrays |
| H01 | Bảng điểm/minimap/chat/diplomacy4 | Không chỉ hiện hai người, recipient không lệch slot |
| H02 | Cùng type khác owner1..4 | Màu/unit selection/đạn đúng; không dùng nhầm asset owner0 |
| H03 | Một người rời hoặc host đổi | HUD cập nhật status, không đổi màu hoặc unit owner người khác |
| H04 | Asset null/unused/terrain redirect | Audit không báo false missing; lỗi dùng thực tế có danh sách rõ |
| V01 | Client rules/protocol/build/asset mismatch | Chặn trước Start theo policy; không fake ready với hai luật khác nhau |
| V02 | Pack thiếu file/frame/màu4 hoặc build thiếu | Readiness không báo ready; synthetic pass không chứng minh art thật |
| V03 | Version metadata và handshake codec | Wire round-trip/validation đúng schema; chưa yêu cầu UI/server integration |
| V04 | Server nhận phiên bản không khớp | Reject ready/start theo authority/config fixture; không phụ thuộc UI triển khai sau |
| O01 | Launcher khởi động từ cwd khác, path có dấu/cách | Tìm đúng runtime/build/asset, không lỗi quoting |
| O02 | Thiếu runtime/build/asset hoặc port đã dùng | Lỗi có hướng xử lý, không kill process khác hoặc tự install âm thầm |
| O03 | Nhiều interface/IP, loopback/VPN | Cho chọn địa chỉ đúng; link LAN không dùng localhost |
| O04 | Start lặp, Stop, process chết, PID reuse | Chỉ quản lý process tree của launcher; không tạo server trùng/kill nhầm |
| O05 | Server host tab đóng nhưng process còn | Khách còn chơi theo policy; tắt process là lỗi kết nối rõ |
| O06 | Launcher→production server→UI/asset/ws thật | Health/readiness/version đúng và cùng origin; không dựa mock spawn duy nhất |
| O07 | Tunnel output tạo URL, lỗi/timeout/restart | Parse URL an toàn, trạng thái chính xác, không link stale |
| O08 | Tunnel token/process ownership | Không lộ token; chỉ dừng tunnel do launcher tạo |
| O09 | Client ngoài LAN | HTTPS + WebSocket kết nối, link phòng và reconnect hoạt động qua tunnel thật |
| A01 | Bốn browser contexts trên một máy | Start, lệnh bốn phía và hash same-turn giống nhau |
| A02 | Fifth join + invite errors + reconnect | Toàn luồng UI đúng, không sót client/background timer |
| A03 | Room2/single-player regression | Setup, bot, pause, speed và legacy ready/start vẫn đúng |
| A04 | Fake RTT và peer mất giữa trận | Không thiếu/nhân command, đúng drop/result, không cả phòng chết |
| A05 | Full guard/lint/typecheck/unit/build | Exit0 hoặc lỗi/skip nêu tên; không sửa timeout/guard để che regression |
| A06 | Seeded soak4 nhiều seed/civ/map | Không desync/leak, ghi first divergent turn và command trace |
| A07 | Cross-engine determinism4 | Cùng replay4 chạy Node/Chromium/Firefox/WebKit cho cùng hash; engine thiếu báo riêng |
| A08 | Bốn thiết bị LAN | Thật sự tải và chơi được từ máy khác, không chỉ bốn tab localhost |
| A09 | Internet ngoài LAN và bàn giao | Chứng minh remote link/ws, tắt tunnel/server báo đúng; có hướng dẫn launch/share/stop |

## Cách xây tests

- Protocol/relay dùng fake peers và fake clocks; kiểm tra side effect thật vào room/accepted commands, không assert mock riêng.
- Có integration4 World nhận cùng `World.addBatch`; chạy đủ command delay rồi so checksum ở cùng turn.
- Fake timers cho drop/rejoin/pause/resume, không ngủ thật cho unit tests.
- E2E bốn context dùng state waits. Giới hạn worker để tránh tranh CPU; bốn browser cùng máy vẫn khác với bốn thiết bị thật.
- Khi dùng random map, giữ seed cố định và log seed. Chưa có fixture4 thì phải tạo; không dùng fixture2 rồi ghi đã test4.
- Một test holder sở hữu port5273/8887; test launcher dùng port riêng từ allocator, không kill server người dùng.
- Real LAN/Internet tests chỉ chạy trong môi trường người dùng đã cho phép; không tự mở firewall/router/tunnel tài khoản.

## Lệnh tham khảo cho lần triển khai

Chạy tại repo root. Dùng danh sách file, tránh regex chứa `|` bị npm/cmd trên Windows xử lý thành pipeline.

```powershell
npm run check
npm run build
npm test -w @aoe/protocol
npm test -w @aoe/server
npm test -w @aoe/client -- src/lobby src/lockstep
npm test -w @aoe/sim

# Chỉ dùng khi file mới đã được tạo và discovery đúng
npm run test:e2e -- tests/multiplayer4-lobby.spec.ts tests/multiplayer4-game.spec.ts tests/multiplayer4-reconnect.spec.ts
npm run test:e2e -- tests/lobby.spec.ts tests/single-player-setup.spec.ts tests/single-player-pause.spec.ts tests/single-player-speed.spec.ts

# Chẩn đoán timeout: chạy test fail riêng trước, rồi nếu cần giới hạn worker;
# ghi cả failure và rerun, không bỏ assertion hoặc tự tăng timeout để giấu lỗi.
npm test --workspaces --if-present -- --maxWorkers=2
```

Suite soak hiện tại thiên về2 client. M14 phải bổ sung entry/config4 theo API đã chốt, không chạy `npm run test:soak` cũ rồi gọi đó là soak4. Đề xuất mục tiêu: 3 seed cố định, 20 phút game mỗi seed, có scenario cưỡng bức drop/rejoin, FFA elimination và có thể kết thúc rồi tạo trận mới. Thời gian thực phụ thuộc tải; ghi rõ phần chưa chạy.

## Evidence và gates

Mỗi worker trả JSON theo [result.schema.json](result.schema.json), có command/exit code/test counts/log paths/seed/limitations. Reviewer xác minh diff và không dựa báo cáo worker duy nhất. Khi thiếu environment, ghi BLOCKED thay vì DONE.

Gate code không thay thế gate product: unit/E2E một máy đạt không tự động đạt A08/A09. Không có quyền mở tunnel hoặc thiếu máy ngoài LAN thì ghi điều kiện còn thiếu, giữ nghiệm thu thực địa chưa đạt. Không tự deploy để hoàn tất checklist.

Manual evidence dùng kind=manual và exit_code=null nếu không có shell command; ghi người thực hiện, thiết bị/mạng và artifact. Harness phải đối chiếu run_id/worker_id/base/contract, covered_test_ids với test_ids trong evidence, required IDs của task và trạng thái fail/skip; JSON hợp lệ không tự chứng minh test đã chạy.
