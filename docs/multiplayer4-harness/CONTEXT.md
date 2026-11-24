# Context — Multiplayer 4 người, một máy chủ chia sẻ link

Ngày kiểm kê: **2026-11-24**. Repository đích: `D:\deche\decheonline`.

Đây là context và thiết kế cho **lần triển khai sau**. Chưa có tính năng multiplayer 4 người được triển khai hoặc test đạt chỉ vì tài liệu này được tạo. Agent phải đọc lại mã tại commit được giao.

## Điểm vào harness

- [TASKS.md](TASKS.md): phạm vi, phụ thuộc, ownership và điều kiện hoàn thành.
- [CONTRACTS.md](CONTRACTS.md): quy ước dùng chung; M00 phải đóng băng trước khi code song song.
- [PROMPTS.md](PROMPTS.md): prompt orchestrator, implementer, reviewer và handoff.
- [TEST_MATRIX.md](TEST_MATRIX.md): ca kiểm thử và điều kiện nghiệm thu.
- [tasks.json](tasks.json): DAG/status/file ownership để harness đọc bằng máy.
- [result.schema.json](result.schema.json): schema báo cáo của worker.

## Trải nghiệm cần đạt

1. Chủ máy mở launcher, thấy server và asset đã sẵn sàng.
2. Chủ máy vào game, tạo phòng sức chứa 4 và sao chép link mời có mã phòng.
3. Ba người còn lại mở link, nhập tên, chọn văn minh, Ready.
4. Chủ phòng Start khi đủ bốn người sẵn sàng.
5. Mọi máy chạy cùng trận; một người rời/đầu hàng không làm ba người kia bị đóng trận.
6. LAN dùng địa chỉ IP LAN; Internet dùng URL HTTPS của tunnel được cấu hình. Khách không phải clone code hoặc cài Node.

## Phạm vi bản đầu

- 4 người thật, free-for-all; hỗ trợ chọn sức chứa 2 hoặc 4 khi tạo multiplayer. Create cũ thiếu capacity vẫn tạo phòng 2 để giữ tương thích.
- Single-player tiếp tục đúng 2 slot: người + bot có token. Không thay luật pause/speed đã có cho single-player.
- Slot ổn định, reconnect, đầu hàng, chuyển quyền chủ phòng khi cần, link mời, HUD/map/asset cho bốn màu.
- Launcher Windows chạy **bản build production**, phục vụ UI, asset và WebSocket trên một cổng.
- Hai cách chia sẻ: LAN; Internet qua tunnel. Không bắt buộc mua tên miền cho bản thử nghiệm. Tunnel tạm phải được gọi đúng là tạm, không hứa URL cố định.
- Trạng thái launcher/error/log phải dùng được; báo rõ đóng server hoặc máy ngủ sẽ làm mất phiên.

## Ngoài phạm vi bắt buộc

2v2/đội, đóng slot rồi thay đổi số người tùy ý giữa lobby, bot lấp multiplayer 4 slot, người xem/join muộn, tài khoản/xếp hạng, database, cloud autoscaling và di chuyển trận đang chạy sang máy chủ khác. Tách proposal riêng nếu muốn làm tiếp; không thêm âm thầm vào MVP.

## Hiện trạng mã đã đọc

| Khu vực | Bằng chứng hiện tại | Cần bổ sung |
|---|---|---|
| Protocol | `packages/protocol/src/messages.ts`: `MAX_PLAYERS = 2`, slot chú thích 0/1 | Room capacity theo mode; slot 0..3 và validation tất cả recipient/array |
| Room | `apps/server/src/rooms.ts`: join/start dùng MAX_PLAYERS toàn cục | Tách sức chứa tối đa khỏi điều kiện Start từng phòng; giữ single-player 2 slot |
| Thành viên | `members.map((m, slot)...)`, `indexOf(member)`, `members[slot]`, `splice` khi rời | Identity slot ổn định, không đổi owner/unit/rejoin token của người còn lại |
| Lifecycle | Một số đường resign/drop gán `room.gameOver = true`; leave đang chơi có thể closeRoom | Một người bị loại không đồng nghĩa cả trận kết thúc |
| Lobby | `lobby-view.ts` có `players.length === 2`, `< 2` | UI 4 slot, ready/capacity/host role, giữ lựa chọn theo slot |
| Simulation | `lobbyWorldOptions` đã tính `players = civs.length + 1`; player 0 là Gaia | 4 người = 5 player, kiểm tra mọi array/start position/diplomacy/victory/replay |
| Map | Random map nhận số human; test map đã có 4 tọa độ BASES | Kiểm tra đủ footprint/resource/reach cho4; không sửa lại phần đã đáp ứng chỉ vì giả định code còn2 vị trí |
| Networking | Client dùng URL `/ws` theo origin; server đã serve `/`, `/assets/*`, `/ws` | Khai thác cùng origin cho link LAN/tunnel, version gate, không hardcode localhost ở client |
| Hosting | Node server mặc định PORT 8787; có deploy docs/tunnel cho VM | Launcher máy cá nhân, kiểm tra asset/port, link LAN và lifecycle tunnel |
| Tests | Có relay, lockstep, lobby, single-player, determinism, soak | Fixture 4 client; suite soak cũ 2 client không chứng minh 4 người |

File nguồn chính: `packages/protocol/src/{messages,codec}.ts`, `apps/server/src/{rooms,app,main,assets,speed}.ts`, `apps/client/src/{multiplayer.ts,lobby/,net/,lockstep/,hud/}`, `packages/sim/src/{world,game-settings,replay,victory,diplomacy,rmm-controller}.ts`.

## Hai khái niệm host phải tách biệt

**Máy chủ vật lý** chạy Node và tunnel. Tắt máy/tiến trình này thì trận dừng; chuyển quyền chủ phòng không thay thế được máy chủ vật lý.

**Chủ phòng** là một role điều khiển lobby của người đang kết nối. Chuyển role không đổi slot, màu, player ID, quyền sở hữu unit hoặc reconnect identity. Đề xuất chuyển role cho slot nhỏ nhất còn kết nối khi chủ phòng rời; trong trận không nới quyền pause multiplayer chỉ vì đổi host.

## Luật kỹ thuật bất biến

- Đọc `AGENTS.md` tại checkout. Node >=24, TypeScript/npm workspaces, Vite/PixiJS, Vitest/Playwright hiện có.
- Không sửa sim bằng DOM/network/Date/Math.random. Giữ float32/RNG helpers và thứ tự command tất định.
- Protocol slot 0..3 ánh xạ sim player slot+1. Gaia luôn player 0. Không biến bốn người thành `players:4` nếu trường đó gồm Gaia.
- Không lọc/xóa/đổi thứ tự mảng civ theo người còn sống sau Start; giữ manifest khởi tạo cho cả trận.
- Các client phải có cùng rules/build/asset version; metadata hiển thị bên ngoài không đủ để nhận diện bản luật.
- `COMMAND_DELAY_TURNS` và checkpoint phải theo spec; so hash cùng turn, không cùng wall time.
- Game state chỉ đổi qua command đã đồng bộ. Client không tự resign hộ người khác bằng cách đổi owner/local world.
- Server kiểm tra quyền từ socket + room membership, không từ tên người chơi, cờ client hoặc dữ liệu URL.
- Không gửi token rejoin/bot/server/tunnel trong link mời hoặc log công khai.
- Không tự xóa asset, sửa generated tables, nới guard, kết thúc process người dùng hoặc ghi thay đổi firewall/router để làm test qua.
- Không deploy/push, cấu hình tên miền/tunnel tài khoản hoặc thay mạng máy thật nếu chưa được giao; unit/integration test dùng fixture riêng.
- Bảo toàn thay đổi đã có trong Phase 2. Đọc lại trạng thái Git; không reset/clean hoặc ghi đè file của người khác.

## Tiêu chí chấp nhận tổng thể

Mọi task M00–M14 có evidence và review. Bốn client đồng bộ trên fixture và random map, người thứ năm bị từ chối, một người rời không làm đóng cả trận, single-player/phòng 2 người không hồi quy, launcher LAN dùng được và link Internet được kiểm tra qua mạng ngoài khi có môi trường. Nếu thiếu máy/mạng ngoài/asset, ghi phần chưa kiểm chứng; không ghi DONE cho nghiệm thu thực địa chưa thực hiện.
