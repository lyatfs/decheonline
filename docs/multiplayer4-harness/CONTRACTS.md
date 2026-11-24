# Contracts multiplayer4 — frozen mp4-v1

Tên type/field dưới đây là **thiết kế đề xuất**, không khẳng định đang có trong code. M00 kiểm kê rồi chốt exact API, version và cách chuyển đổi; downstream chỉ dùng contract đã được tích hợp vào baseline chung.

## C01 — Room capacity, slot và manifest trận

```ts
type RoomCapacity = 2 | 4;
type SlotId = 0 | 1 | 2 | 3;
type SeatStatus = 'open' | 'occupied' | 'away' | 'resigned' | 'dropped';
interface RoomSeat {
  slot: SlotId;
  status: SeatStatus;
  name: string | null;
  civ: number | null;
  ready: boolean;
  // Không chứa reconnect token hoặc bot token.
}
```

- `MAX_PLAYERS=4` chỉ là giới hạn giao thức; phòng giữ `capacity` riêng. Single-player capacity=2, multiplayer mặc định=2, create chọn4 mới nhận thêm slot2/3.
- Bốn slot được dự trữ từ lúc create; slot trống trả trạng thái open. Không cần closed/spectator trong MVP.
- Join lấy slot trống nhỏ nhất trong capacity; Start cần mọi slot của capacity đã có người và ready. Phòng4 không được start khi chỉ có3 người. Phòng2 và single-player không đợi4.
- Leave lobby trả ghế về open, không đánh lại số ghế còn lại. Clear ready sau thay đổi membership/settings theo chính sách chốt ở M00.
- Start chứa immutable manifest có participant slot/playerId/civ, seed, settings, room mode/capacity, hostSlot, versions. Rejoin/snapshot giữ manifest đó dù một người đã bị loại.
- Nếu code cũ tạo world bằng `start.players.map(...)`, M00 phải chốt luôn việc bảo toàn thứ tự slot/civ và xử lý entry thiếu; không để mỗi agent tự chọn.
- Thông điệp create/join/ready/start/rejoin/chat nhận slot3 hợp lệ khi thích hợp; reject slot4, âm, NaN, fractional và recipient không thuộc phòng. Server vẫn xác thực capacity của phòng sau validation tối đa protocol.

## C02 — Chủ phòng và identity

- `hostSlot` là role có thể đổi; không mặc định `slot===0` cho mọi quyền multiplayer.
- Quyền settings/start/kick nếu triển khai chỉ dành hostSlot. Không nhận hostSlot client tự khai.
- Lobby có host rời: chuyển cho slot nhỏ nhất còn kết nối; gửi lobby snapshot authoritative. Trận đang chơi: role có thể chuyển nhưng slot của cựu host vẫn là away/resigned/dropped.
- Chế độ single-player giữ host human slot0, bot slot1 và bot token hiện có; không cho bot nhận quyền single-player host.
- Không mô tả host-role transfer là live server migration. Server process ngừng thì mọi trận trong process ngừng.

## C03 — Turn, checksum, reconnect và kết thúc

- Phân biệt `active turn senders` với toàn bộ immutable participants. Người resigned/dropped không tiếp tục chặn lượt; server điền batch rỗng hoặc resign đúng turn theo spec đã chốt.
- Lệnh đã accepted trước khi drop được áp dụng một lần, không bị xóa hoặc phát lại sai thứ tự. Slot reconnect phải khớp token + room + participant gốc; không join mới vào trận đang chạy.
- Deadline xử lý người away có giới hạn, không tự động dừng cả phòng vĩnh viễn. Release và RTT/buffer phải bỏ người đã được loại khỏi wait set theo quy tắc rõ ràng.
- Checksum so giữa các peer phải báo cáo tại cùng turn. Không coi hash chưa nhận là số0 hợp lệ để kết luận desync.
- Một người resign/drop không set match-finished. Chấm dứt dựa trên điều kiện thắng sim và cơ chế báo cáo/xác nhận kết quả đã được thiết kế, hoặc khi không còn kết nối.
- Vì relay không chạy toàn bộ sim, M00/M04 phải chốt result-report/consensus hoặc quy tắc kết thúc khác có test; không tin một client tùy ý tuyên bố thắng và đóng phòng.
- Đặc tả phải nói rõ peer bị loại nhưng vẫn xem trận còn gửi checksum/batch hay server tự điền. Không trộn spectator tương lai với wait set hiện tại.

## C04 — Link mời và địa chỉ truy cập

- URL dạng `<publicOrigin>/?room=ABCDE`; dùng URL API, chuẩn hóa code theo validator hiện có.
- Link chứa room code, không tự grant host/bot/rejoin quyền. Mở link điền sẵn code và cho nhập tên; không tự ready/start.
- Base origin lấy từ cấu hình launcher/public URL có validate hoặc location.origin của người đang truy cập. Không dùng localhost làm link gửi máy khác.
- LAN link và Internet link là hai giá trị riêng. Không lấy địa chỉ VPN/loopback ngẫu nhiên rồi ghi là LAN khả dụng; cho chọn interface nếu nhiều IP.
- Link phòng đã hết, đầy, started hoặc server offline có UI lỗi/retry; không xóa setup của người dùng vì một request lỗi.

## C05 — Phiên bản và assets

- Handshake kiểm tra protocol/rules/build/asset identifiers trước khi ready/start. M00 chốt cách tạo ID tái lập và so khớp; chỉ số PACK_VERSION mô tả schema chưa chứng minh toàn bộ dữ liệu giống nhau.
- Không có pack đủ thì launcher báo thiếu file; không im lặng chuyển sang hình debug và tuyên bố sẵn sàng chơi art thật.
- Mọi URL/path trong manifest phải được kiểm tra; màu owner1..4 phải đủ cho các graphic dùng thực tế. Các entry null/unused hoặc terrain.draw redirect phải được phân loại đúng, không báo tất cả là thiếu.
- Không tự tạo phiên bản dữ liệu bằng sửa tay generated `unit-data.ts`. Đồng bộ sim sprite metadata với asset khi sửa nội dung hợp lệ.

## C06 — Launcher và tunnel

- Một process game server phục vụ HTTP UI + assets + WebSocket. Không dùng Vite dev làm server phân phối cho bạn bè.
- Launcher có start/status/stop; kiểm tra build/runtime/assets/port, log có thể đọc, nhận cấu hình PORT/HOST/ASSETS_DIR/PUBLIC_URL hoặc tên tương đương do M00 chốt.
- Hai chế độ: LAN; Internet tunnel opt-in. Máy host có thể chạy game như client khác.
- Dùng đường dẫn tuyệt đối dựa trên launcher location, hỗ trợ dấu cách/Unicode và không phụ thuộc current directory của shell.
- Chỉ dừng PID/process tree launcher đã tạo, xác minh PID không bị tái sử dụng; không kill mọi node/cloudflared. Launcher không tự chạy npm install, firewall change hoặc mở port router với quyền admin.
- Nếu bind mặc định của Node đã nhận LAN, kiểm tra thay vì sửa vô ích. Firewall có hướng dẫn thao tác rõ, thay đổi hệ thống cần sự cho phép cụ thể.
- Tunnel runner chỉ nhận executable/args kiểm soát; không shell-eval URL/room input. Che token trong log. Quick URL có thể thay đổi; tắt tunnel thì link hết hiệu lực.
- Không tự tải/chạy binary tunnel từ nguồn chưa kiểm chứng. Dùng binary do người dùng cài hoặc quy trình cài có xác minh nguồn và được giao rõ.

## Contract freeze

M00 ghi exact types/message examples/public module APIs trong phần bổ sung của file này và đổi contract status từ draft thành frozen. Mọi thay đổi sau đó phải có version mới, owner, migration, test ảnh hưởng và thông báo downstream; không để hai agent tự sửa cùng type theo hai hướng.

## M00 freeze — mp4-v1, 2026-11-24

Phần này thay thế các lựa chọn còn mở ở trên. Baseline source: `7b4da47917bce4be0dd6d9f6aaf92414b773225a`, branch `sang`. User giao triển khai M00–M04 tại checkout hiện tại; không tạo worktree, không commit/push. Tài nguyên untracked hiện có được giữ nguyên. Quyền ghi: protocol worker chỉ `packages/protocol/src/`; server worker chỉ `apps/server/src/`; orchestrator giữ docs và client lockstep. M02 chỉ implement sau M01 tích hợp; M03 sau M02; M04 sau M03.

### Exact wire API

`RoomCapacity = 2 | 4`, `DEFAULT_ROOM_CAPACITY = 2`, `MAX_PLAYERS = 4`. `Slot` vẫn là number để tương thích caller; decoder/boundary kiểm tra integer 0..3. `SlotId = 0 | 1 | 2 | 3` dùng khi cần.

`CompatibilityVersions = {protocol:string,rules:string,build:string,assets:string}`. Mỗi ID không rỗng, tối đa128 ký tự. Export `isRoomCapacity`, `isCompatibilityVersions`, `sameCompatibilityVersions`, `DEFAULT_COMPATIBILITY_VERSIONS`. Development authority: `{protocol:'mp4-v1',rules:'sim-v1',build:'development',assets:'development'}`. `RoomRegistryOptions.versions?: CompatibilityVersions` thay authority khi khởi tạo; client không quyết định authority. Đây là ID phát triển, **chưa là fingerprint nội dung production**; M11 phải thay build/assets và nối `/api/versions`.

- `create`: thêm `capacity?`, `versions?`; thiếu capacity mặc định2. Single-player capacity4 bị reject. Room4 bắt buộc versions khớp authority. Room2/single-player cho thiếu versions; nếu có vẫn phải khớp.
- `join`: thêm `versions?`, cùng chính sách theo phòng đích. `ready`: thêm `versions?`; dùng handshake đã lưu nếu thiếu. Reject mismatch trước mutation, kể cả Ready/Start. Error mới `version-mismatch`.
- `lobby`: thêm `capacity`, `hostSlot`, `seats:RoomSeat[]`, `versions`. `RoomSeat = {slot,status,name,civ,ready}`; name/civ null ở open. Không gửi token trong seats/manifest.
- `start`: thêm `capacity`, `hostSlot`, `versions`, `manifest:MatchManifest`.
- `rejoined`: thêm cùng metadata và nguyên manifest start; `nextTurn` giữ nghĩa first unaccepted batch của member.
- `MatchParticipant = {slot,playerId,name,civ}`; `playerId = slot+1`. `MatchManifest = {code,capacity,mode,hostSlot,players:MatchParticipant[],seed,settings,versions}`. Clone/freeze tại Start; hostSlot trong manifest là host lúc start. Role hiện tại lấy field hostSlot ngoài manifest. players trong wire Start và manifest theo slot tăng dần; giữ đủ participant gốc sau drop, Gaia luôn0. Bốn human tạo World với civs `[slot0.civ,...,slot3.civ]` và5 sim players. Không compact arrays sau start.
- Metadata mới trong ServerMessage được khai báo optional để fixtures/caller cũ còn typecheck; server mới luôn gửi. Đây không phải hỗ trợ binary client cũ thiếu handshake vào room4.
- `result`: client gửi `{t:'result',turn,hash,winners:number[]}`; turn safe nonnegative integer, hash uint32, winners unique sim IDs1..4 (mảng rỗng hợp lệ cho hòa). Server xác thực winners thuộc manifest và turn đã submit, không quá log+command delay.
- `ended`: reason thêm `completed`, `result?:{turn,hash,winners}`; `bad-result` cho báo cáo không hợp lệ. Chỉ completed khi cùng turn/hash/winners có agreement từ tất cả participant còn active. Một vote không đủ khi có nhiều active. Không tự xác nhận kết quả bằng loại bỏ voter khác. Client báo kết quả lần đầu sau endTurn có gameResult và gửi lại khi rejoin. completed dừng net loop nhưng giữ màn hình kết quả game; không gọi callback quay lobby dành cho mất kết nối.

### Membership và lifecycle

`Member.slot` cố định; members là collection, không dùng index làm identity. Join lấy ghế trống thấp nhất. Lobby leave chỉ xóa member đó; clear ready tất cả khi join/leave/settings đổi. Host chuyển sang slot kết nối nhỏ nhất; single-player bot không nhận quyền host (human rời lobby thì đóng phòng). Không thêm kick.

Start cần đủ capacity và mọi member ready + version phù hợp. Bắt đầu rồi không join mới. Broken socket giữ token/slot và chờ grace `DROP_AFTER_MS`; rejoin token đúng trước drop lấy lại identity và replay `log.slice(received)` đúng một lần. Invalid slot/token/received không mutation. Resigned/dropped không rejoin thành active trở lại.

Accepted batch luôn bất biến. Explicit leave trong trận hoặc timeout inject resign ở `member.nextTurn`, sau các batch đã accepted; voluntary resign nằm trong batch gốc. Server giữ batch này và tự điền rỗng sau đó; không chờ sender đã resigned/dropped. Vẫn giữ peer resigned kết nối để xem trận, nhận turns/chat; chỉ chấp nhận các batch rỗng tiếp theo của peer này (bỏ qua như keepalive, không thay lịch sử); không cho lệnh mới của người đã resign. Không thể release vô hạn khi mọi sender đã inactive: release chỉ khi có batch accepted/injected hoặc active sender làm mốc. RTT/G/F chỉ xét active senders, dùng tổng hai RTT lớn nhất cho pair latency của relay; các vector wire luôn indexed slot, inactive bằng0.

Checksum chỉ so cùng turn khi mọi active có sample. Missing không coi là0 khi so;0 là hash hợp lệ. Bỏ reports cũ đã so, chặn quá xa và giữ bộ nhớ có giới hạn. Khi quorum đổi, kiểm tra lại turn đang chờ. Result agreement là nhất trí giữa client, **không phải chống gian lận bằng authoritative sim**; relay không chạy simulation. Giữ tập voter active tại thời điểm report đầu tiên; người timeout/leave được loại có điều kiện nhưng không để một report cũ tự kết thúc sau thay đổi quorum: xóa result round và yêu cầu report mới từ tập còn lại. Client còn gameOver gửi lại mỗi endTurn để hội tụ sau thay đổi quorum. Hash/result khác turn/hash/winners không kết thúc. Khi không còn socket kết nối thì dọn room/byPeer/timer ngay. Không set match-finished khi chỉ một người resign/drop. Single-player pause/resume giữ barrier/epoch; resign tự resume để batch đến sim, nhưng khóa pause nếu đã có resign trong single-player.

### API bàn giao M05–M12 (không implement trong M00–04)

- M05 gửi capacity và versions vào create/join, dùng snapshot seats/hostSlot; M10 dùng manifest và gửi result qua Lockstep.
- M06 helper `inviteUrl(origin:string,code:string):string`, `parseInviteRoom(url:string):string|null`, query `room`; không token.
- M11 `/api/versions` trả CompatibilityVersions; `/api/health` trả `{status:'ready'|'not-ready',versions}`. Env `HOST`, `PORT`, `ASSETS_DIR`, `PUBLIC_URL`; giữ default port8787. Chưa triển khai endpoint/launcher/readiness trong scope này.
- M09/M12 host helper module `tools/host/` nhận cấu hình paths tuyệt đối, trả status `{state:'stopped'|'starting'|'ready'|'failed',pid:number|null,lanUrls:string[],publicUrl:string|null,logPath:string}`. Không dùng shell-eval. Tunnel opt-in, executable do người dùng cài. Production fingerprint/asset audit, UI4, link mời, LAN/Internet thật là task sau.

Baseline kiểm kê: fixed test-map `World.BASES` đã có bốn tọa độ; không sửa spawn ở M00–04. Seeded random map và victory4 nghiệm thu trong M07. Baseline/check/review evidence của lần triển khai ghi trong IMPLEMENTATION_M00_M04.md.

### Làm rõ C03 sau hoàn thiện backend — 2026-11-25

Giữ wire mp4-v1. Result report phải tại/sau lượt áp dụng mọi resign đã biết (issued turn + COMMAND_DELAY_TURNS), đã được peer acknowledge và thuộc timeline thực thi được từ log. Giữ checksum đã so trong cửa sổ có giới hạn để đối chiếu report.

Khi active sender còn tồn tại, mọi active sender là voter. Khi không còn active sender, mọi participant gốc còn kết nối là terminal observer voter; empty keepalive chỉ acknowledge tiến độ, không sinh batch mới. Khi gameplay quorum đổi vì resign/drop, xóa result rounds và nâng resultNotBefore. Ngoại lệ terminal: observer rời sau khi tất cả sender đã inactive không thay command/gameplay quorum, nên giữ phiếu terminal đã hợp lệ và kiểm tra lại agreement ngay giữa observer còn kết nối; không yêu cầu endTurn không thể xảy ra tại frontier. Gói turn bị từ chối không mutation frameMs hay accepted commands.

Evidence/source và trạng thái mới nhất: BACKEND_COMPLETION_2026-11-25.md.