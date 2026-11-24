# Context phát triển Giai đoạn 2 — AI Bot và Chơi Đơn

Ngày đối chiếu mã: **2026-11-24**. Repository: `D:\deche\decheonline`.

Đây là tài liệu giao việc, **không phải xác nhận tính năng đã hoàn thành hoặc test đã pass**. Mọi agent phải đọc lại mã và `AGENTS.md` tại commit bắt đầu; không dùng báo cáo cũ thay cho bằng chứng hiện tại.

## Cách dùng bộ tài liệu

1. Đọc file này để hiểu kiến trúc và phạm vi.
2. Đọc [TASKS.md](TASKS.md) để chọn tác vụ theo phụ thuộc và quyền sở hữu file.
3. Dùng [PROMPTS.md](PROMPTS.md) để giao việc cho orchestrator, implementer và reviewer.
4. Thực hiện các ca bắt buộc trong [TEST_MATRIX.md](TEST_MATRIX.md); ghi kết quả thật khi chạy.

## Mục tiêu sản phẩm

- Bot duy trì kinh tế sau khi tài nguyên tự nhiên cạn, xây đủ chuỗi công trình và lên Iron Age khi điều kiện văn minh cho phép.
- Bot nghiên cứu công nghệ phù hợp đội hình, không tiêu trùng ngân sách và không phá lệnh đang thực thi.
- Bot chỉ dùng thông tin được phép quan sát, chọn mục tiêu đi tới được, quản lý quân thành squad/wave có trạng thái.
- Trước trận, người chơi chọn văn minh của mình và máy, loại/kích thước map, độ khó Dễ/Trung bình/Khó.
- Chơi đơn hỗ trợ Pause/F3 và tốc độ linh hoạt, đồng bộ với bot; giữ tương thích multiplayer.

## Hiện trạng đã đọc trong mã, chưa chạy kiểm thử trong lần lập tài liệu này

| Hạng mục | Hiện trạng | Việc còn cần chứng minh/bổ sung |
|---|---|---|
| Market, Farm, voi, vàng, đá | `ai-bot.ts` đã có nhánh xử lý | Hết nguồn thực phẩm, tái canh nhiều vòng, bảo đảm an toàn khi săn, tránh đếm ruộng cạn như ruộng còn sản xuất |
| Công trình và Iron Age | Có Government Center/Temple/Siege Workshop/Academy trong ưu tiên xây, có `IRON_AGE` | Không chỉ xây đủ hai công trình rồi bỏ các công trình còn cần cho chiến lược; điều kiện phải dùng tech/master thực tế |
| Nghiên cứu/nâng cấp quân | Có `PRIORITY_TECHS`, kiểm tra chi phí và building bận | Ưu tiên theo chiến lược, tránh bỏ đói kinh tế, kiểm chứng từng nhánh/civ |
| Nhận thức bản đồ | Có `isEnemyVisible`, `isResourceKnown`, `canLandReach`, `zones.of(...)` | Dùng đúng passability của từng actor; xử lý target bị khuất, đổi chủ, đảo tách biệt và chướng ngại động |
| Lệnh quân sự | Có cooldown, loại quân đang đánh khỏi lệnh mới, gom quân khi phát attack | Chưa thấy model squad/wave lưu trạng thái rõ ràng |
| Lifecycle bot | Có `botSpawning`, `botGeneration`, `cleanupBot()` | Giữ và mở rộng bảo vệ này khi thêm màn hình setup, cancel, retry |
| Chơi đơn | Nút hiện tạo phòng relay, bot là client WebSocket thứ hai, auto-ready/start | Có màn hình setup trước khi tạo/start, truyền profile và lựa chọn civ chính xác |
| Độ khó | Tên mặc định `Computer (Hard)` | Tên không phải implementation độ khó; cần profile hành vi thực |
| Pause | Chưa thấy hợp đồng pause trong protocol đã đọc | Cần server mode, quyền điều khiển và barrier cho cả human/bot |
| Tốc độ | `game-speed` parser giới hạn 1/1.5/2 | `paceScale` hiện vẫn nhân `baseSpeed * gameSpeed`; phải tái hiện và sửa tăng tốc kép trước khi mở rộng |

Test hiện có: `apps/client/src/bot/ai-bot.test.ts` kiểm tra visibility/reachability, chống spam attack, kinh tế/lên đời, nghiên cứu khi building bận, săn voi, đánh cá và placement. **Có test không đồng nghĩa mọi kịch bản đã được bao phủ.**

## Bản đồ mã nguồn

| Phân hệ | File/thư mục cần đọc |
|---|---|
| Bot | `apps/client/src/bot/ai-bot.ts`, `ai-bot.test.ts`; API hiện có `step(world: World): Command[]` |
| Lobby | `apps/client/src/lobby/lobby-view.ts`, `session.ts` |
| Khởi tạo game và HUD | `apps/client/src/multiplayer.ts`, `hud/game-hud.ts`, `hud/options.ts` |
| Đồng bộ | `apps/client/src/lockstep/lockstep.ts`, `net/link.ts` |
| Relay và phòng | `apps/server/src/rooms.ts`, `speed.ts`, `app.ts` |
| Protocol | `packages/protocol/src/messages.ts`, `codec.ts` |
| Luật game | `packages/sim/src/world.ts`, `commands.ts`, `masters.ts`, `techs.ts`, `research.ts`, `buildings.ts`, `make.ts` |
| Map/quan sát | `visibility.ts`, `pathing.ts`, `zone-map.ts`, `game-settings.ts` trong sim |
| Đặc tả | `docs/spec/economy.md`, `techs.md`, `movement.md`, `naval.md`, `lobby.md`, `turn-timing.md` |
| E2E | `e2e/tests/lobby*.spec.ts`, `farm.spec.ts`, `research.spec.ts`, `game-speed.spec.ts`, `determinism.spec.ts`, `soak.spec.ts` |

## Ràng buộc phải giữ

- Node >=24, TypeScript monorepo npm workspaces, Vite/PixiJS, Vitest và Playwright; không thêm dependency nếu thư viện hiện có đáp ứng được.
- Bot chỉ đề xuất/gửi `Command` qua đường lockstep. Không sửa trực tiếp resource, entity, master, tech hoặc visibility của world để tạo lợi thế.
- `packages/sim` thuần tất định; không đưa DOM, network, wall clock hoặc RNG không tất định vào sim. Dùng helper số học/RNG hiện có.
- Tiền, thời gian xây/nghiên cứu, điều kiện lên đời và nâng cấp lấy từ masters/techs/DAT và spec, không từ bảng tự đoán.
- `COMMAND_DELAY_TURNS` hiện là 2. Lệnh nhận bởi relay chưa có nghĩa đã áp dụng vào world. Pending/reservation phải bao phủ thời gian chờ này.
- Không nới tốc độ multiplayer khi mở rộng single-player. Server quyết định room mode và quyền; không tin tên `Computer`, label UI hoặc cờ do khách tự khai.
- Cùng seed, settings, civ, profile và chuỗi observation phải cho cùng quyết định bot; ghi seed để tái hiện. Không dùng wall clock để thay đổi chiến thuật.
- Ngưỡng quyết định kinh tế/quân sự nên theo **thời gian game**; pending network vẫn theo turn. G/F có thể thay đổi nên không coi 2 turn luôn bằng một số giây cố định.
- Không sửa file dữ liệu sinh tự động để thêm chiến thuật bot; kiểm tra pipeline custom unit hiện tại trước khi động tới dữ liệu.
- Không tự import, xóa, ghi đè hoặc đưa asset gốc vào Git. Trạng thái pack có thể thay đổi; kiểm tra lại khi cần E2E thật. Thiếu asset không phải lý do làm test logic bỏ qua lỗi.
- Đọc `AGENTS.md` và guard hiện tại. Nếu quy định và trạng thái file không khớp, báo rõ; không tự xóa tài nguyên hoặc nới guard để cho kiểm tra pass.

## Kiến trúc đề xuất cho phần bổ sung

Giữ mô hình human + bot qua relay trong Giai đoạn 2; **không viết lại thành engine offline**. Tách bot thành các planner, nhưng duy trì API `AiBot.step()` và đường gửi command hiện có.

Các module mới nằm trong `apps/client/src/bot/`: `types.ts`, `difficulty.ts`, `observation.ts`, `budget.ts`, `economy.ts`, `progression.ts`, `research-planner.ts`, `squads.ts`. Tên này là đích thiết kế, chưa khẳng định file đã tồn tại.

Luồng dự kiến: observation hợp lệ → các planner tạo intent → arbiter kiểm tra ngân sách/pending/quyền sở hữu unit → danh sách command → lockstep. Chỉ integrator sửa phần nối trong `ai-bot.ts`; planner không tự gửi WebSocket.

Hợp đồng T00 phải chốt trước khi chạy song song, tối thiểu gồm:

```ts
type BotDifficulty = 'easy' | 'medium' | 'hard';
type RoomMode = 'multiplayer' | 'single-player';
interface SinglePlayerSetup {
  humanCiv: number;
  botCiv: number;
  settings: GameSettings;
  difficulty: BotDifficulty;
}
interface BotIntent {
  command: Command;
  priority: number;
  key: string; // ổn định để chống phát lặp khi lệnh đang chờ
  reason: string;
}
```

T00 bổ sung schema observation, budget claim, planner state, tick và kết quả arbitration. `Readonly<World>` chỉ readonly nông: không coi nó là biện pháp ngăn mutation; ưu tiên observation DTO và adapter chỉ đọc. Đường đọc observation không được sửa game state hoặc tiêu thụ sim RNG.

Mỗi intent phải chỉ rõ tài nguyên/unit/building được giữ chỗ; arbiter là nơi duy nhất chấp nhận và reserve. Hai planner không được cùng tiêu số gỗ hoặc cùng điều khiển một dân trong một tick.

Planner dùng hai pha propose/commit: đề xuất intent không tự tạo pending hoặc cập nhật phase/cooldown như thể command đã được gửi. Arbiter trả outcome theo `key`; chỉ intent accepted mới commit phần state gắn với command. Intent rejected không được giữ reservation hoặc làm squad chuyển sang attacking; retry phải ổn định ở tick sau. Cập nhật observation/memory không phụ thuộc command vẫn được phép. T00 phải chốt API outcome/commit và T02 kiểm thử hợp đồng này.

Độ khó đề xuất thay đổi nhịp nghĩ theo thời gian game, tỷ lệ dân, ngưỡng đánh/rút, số squad và độ sâu nghiên cứu. Tất cả profile tuân cùng fog of war, chi phí và luật. Không mặc định Hard được map-hack hoặc cộng tài nguyên.

## Các quyết định sản phẩm cần phân biệt với luật gốc

- `Clubman → Axeman` và nhánh `Short → Broad → Long Swordsman → Legion` là các nhánh cần đối chiếu tech effect; không tự ghép thành chuỗi Rìu → Kiếm ngắn.
- Improved/Composite Bowman không đồng nghĩa mọi loại Cung T/Cung A/Cung C cùng một chuỗi. Phải dùng ID, tech availability và master sau upgrade thực tế.
- “Có thể xây” không có nghĩa bot phải xây mọi công trình trong mọi trận. Phải có build-order theo chiến lược và có test công trình cần thiết, không ép spam công trình vô ích.
- Tốc độ tự do được đề xuất là giá trị hữu hạn 0.5–4.0, bước UI 0.25, mặc định 1.0. Đây là **mặc định đề xuất**, có thể điều chỉnh khi thực hiện; không cho 0/NaN/Infinity hoặc số không giới hạn. Multiplayer giữ 1/1.5/2.
- Pause là điều khiển phiên, không phải speed=0. Resume phải đi qua control channel vẫn hoạt động khi simulation ngừng.

## Kết quả bàn giao mong đợi

Mỗi task có code, test hồi quy, lệnh/kết quả xác minh, danh sách file, API thay đổi và giới hạn còn lại. Không công bố “hoàn thành Giai đoạn 2” chỉ vì module riêng pass: cần T11 tích hợp và T12 nghiệm thu. Danh sách công việc trong bộ này mặc định đều chưa thực hiện.
