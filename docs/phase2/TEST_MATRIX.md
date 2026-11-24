# Hợp đồng kiểm thử và nghiệm thu

Tài liệu này quy định test cần thực hiện khi triển khai, **không ghi nhận chúng đã chạy**. Các file test được đề xuất chưa tồn tại thì task owner phải tạo; không chạy filter rỗng rồi coi là pass.

## Nguyên tắc

- Unit test planner dùng World/observation fixture kiểm soát seed; assert quyết định và hậu quả quan sát được, không chỉ method mock được gọi.
- Integration đưa command vào `World.addBatch`, chạy đủ `COMMAND_DELAY_TURNS` và kiểm tra state thực. Giữ regression qua public `AiBot.step(world)`.
- Fake clock/relay kiểm tra scheduler, pause, resume, latency và command đang chờ. Không dùng sleep thật cho các test này.
- E2E dùng điều kiện state/DOM thay cho chờ cố định; custom debug hook phải có type trong `e2e/globals.d.ts`.
- Khác biệt difficulty phải đo hành vi trên cùng seed/scenario, không assert tên hiển thị. Không yêu cầu Hard thắng mọi seed hoặc mọi người chơi.
- Test nhiều tick/chu kỳ để bắt Farm cạn lần hai, reservation rò rỉ, squad churn và lifecycle sau reconnect.
- Logic tests độc lập asset thật. E2E synthetic không chứng minh art thật đầy đủ; real-asset checks phải báo rõ pack và skip nếu thiếu.

## Ma trận bắt buộc

| ID | Tình huống | Kết quả/điều kiện phải kiểm tra |
|---|---|---|
| D01 | Cùng seed/input/profile, replay lại | Command trace và planner state bằng nhau; không phụ thuộc Date/performance.now |
| D02 | Easy/Medium/Hard | Profile khác nhau có giới hạn; cùng quyền nhìn/chi phí, không cộng resource |
| D03 | Profile thiếu/sai, Random civ | Default hợp lệ, reject input sai; Random được resolve từ seed có thể replay |
| P01 | Enemy/resource trong TILE_BLACK | Không trở thành mục tiêu hay tác động ưu tiên nhờ dữ liệu bí mật |
| P02 | Mục tiêu ở đảo khác | Không phát work/attack không thể tới; có fallback scouting/economy |
| P03 | Actor land/sea/passability khác nhau | Kết quả reach dùng master actor; không coi một zoneMap đúng cho mọi actor |
| P04 | Target chết/đổi chủ/mất visibility/vật cản động | Hủy hoặc replan có giới hạn; không giữ target invalid hay spam |
| B01 | Hai planner cùng tiêu 100 wood còn lại | Chỉ command hợp lệ trong ngân sách được nhận; priority/dedup ổn định |
| B02 | Lệnh chưa applied trong CTI=2 | Không đặt hai foundation, research, queue hoặc giao hai việc cùng unit |
| B03 | Pending applied/failed/expired, actor chết | Release đúng một lần, không khóa budget vô hạn hoặc chi kép |
| B04 | Nhiều squad/building cùng tick | Không vượt MAX_COMMANDS_PER_BATCH, không starvation task quan trọng |
| B05 | Build/attack bị arbiter reject rồi retry | Không commit pending/phase/cooldown của lệnh bị loại; retry ổn định, accepted commit đúng một lần |
| E01 | Berries/gazelles cạn sau Tool/Market | Xây và dùng Farm nếu afford/enabled, food phục hồi |
| E02 | Ruộng cạn liên tiếp hai chu kỳ trở lên | Tái canh/thay ruộng theo luật sim; ruộng hết food không làm farm target bị kẹt |
| E03 | Mine/tree cạn hoặc không tới được | Đổi nguồn; giữ dân phục hồi food/wood, không lặp work vào target cạn |
| E04 | Voi, dân ít, thiếu HP/đường đi | Không lao một dân yếu vào mục tiêu không an toàn; đội săn hợp lệ khi đủ điều kiện |
| G01 | Khởi đầu chuẩn, các civ có điều kiện khác nhau | Không kẹt vĩnh viễn; lên đời theo tech availability và cost thật |
| G02 | Căn cứ chật/pop-cap, builder chết, foundation bị phá | Tìm vị trí thay thế đi tới được; không đếm pending như công trình hoàn tất |
| G03 | Đã đủ điều kiện Iron nhưng thiếu công trình chiến lược | Vẫn xây công trình cần cho chiến lược; không ép xây mọi công trình vô ích |
| R01 | Tech disabled/done/wrong location hoặc building bận | Không issue research; không chặn train/lên đời vô hạn |
| R02 | Nâng cấp nhánh quân qua nhiều đời | Master thực thay đổi đúng; train đúng record, không ghép sai cây nâng cấp |
| R03 | Hai building nghiên cứu cùng tech + budget age-up | Không research trùng; ưu tiên ngân sách rõ và có test |
| M01 | Nhiều think tick, target vẫn hợp lệ | Không phát lại cùng attack; trace có bound theo transition/cooldown |
| M02 | Reinforcement, member chết/convert | Membership duy nhất, bổ sung hợp lý, không kéo toàn quân reset rally |
| M03 | Defend/attack/retreat/recover | Có state transition và điều kiện thoát, không ping-pong vô hạn |
| M04 | Quân chia đảo/passability, target mất | Squad/target được replan; không tấn công xuyên map nhờ fog leak |
| C01 | Multiplayer client tự nhận single-player hoặc tên Computer | Server không cấp quyền điều khiển tương ứng |
| C02 | Create cũ, lobby/start/rejoin | Tương thích multiplayer, mode authoritative và profile phiên không mất |
| C03 | Người khác chiếm slot bot hoặc sửa settings sau ready | Reject; lifecycle room không vào state nửa chừng |
| U01 | Chọn civ người/máy, map/size, difficulty | Giá trị đúng ở start của cả hai peer, không dùng snapshot settings cũ |
| U02 | Click Start nhiều lần/cancel khi spawn đang chờ | Một room/bot/timer hợp lệ; promise muộn không hồi sinh phiên cũ |
| U03 | Spawn/network fail rồi retry, rời phòng/game over | Cleanup và thông báo có ích; retry không nhân client bot |
| U04 | Vào multiplayer sau single-player | Không auto-ready/start hoặc giữ bot/profile từ phiên trước |
| Q01 | Pause lúc có batch đang gửi/release hoặc startup | Hai peer dừng ở cùng boundary được thống nhất, không bỏ/nhân lệnh |
| Q02 | Giữ pause qua nhiều giây thực | Turn/worldTime/sim state không tiến, control/ping hoạt động, không false stall |
| Q03 | Resume sau pause dài | Không burst chạy bù; pending đúng, checksum bằng nhau tại cùng turn |
| Q04 | F3 lặp, stale/duplicate epoch, game over | Operation idempotent; không toggle nhầm hoặc hồi sinh game |
| Q05 | Rejoin/disconnect khi paused | Mode/pause state khôi phục, có đường resume hoặc kết thúc rõ, không deadlock |
| S01 | 1/1.5/2 với G/F/frame giả lập cố định | Game/base đúng hệ số; pacing không co vì gameSpeed, không ra hệ số bình phương |
| S02 | Single-player 0.5–4 đề xuất, invalid input | Clamp/reject theo contract; reject NaN/Infinity/0/âm; multiplayer chỉ1/1.5/2 |
| S03 | Đổi speed khi pause/resume và giữa trận | Áp dụng cùng boundary, không lệch peer, không burst |
| S04 | Debug speed, server retune G/F, nhiều client | Giữ debug semantics; game speed không phá giả định buffer; checksum cùng tick |
| I01 | Planner được nối vào AiBot.step/network thật | Feature thể hiện trong command trace và World sau CTI, không có module chết |
| I02 | Human+bot: setup→kinh tế→đời→squad→pause→resume | Profile/settings đi xuyên luồng, game tiếp tục, không desync |
| I03 | Hai người multiplayer | Lobby, ready/start, chat, speed cũ, reconnect vẫn hoạt động |
| I04 | Replay/snapshot ở cùng tick | Checksum/snapshot tương thích theo contract đã thay; dùng JSON round trip khi cần |
| A01 | Full static/unit/build checks | Exit0 hoặc có báo cáo fail theo tên và nguyên nhân; không che lỗi bằng skip |
| A02 | Determinism đa engine | Cùng seed/accepted commands cho cùng checksum; ghi engine không chạy được |
| A03 | Soak nhiều seed/map/civ/profile | Không desync/pending leak/command spam; ghi seed và first divergence |
| A04 | UI thật/synthetic, bàn phím/viewport nhỏ | Setup dùng được, F3 không cướp input chat/form, báo riêng thiếu asset |

## Lệnh xác minh

Chạy tại repository root. Những lệnh dưới đây là hướng dẫn cho lần xây dựng tính năng, không phải bằng chứng đã chạy.

```powershell
# Baseline và nghiệm thu
npm run check
npm run build

# Bot/module unit tests (đảm bảo các file mới đúng workspace discovery)
npm test -w @aoe/client -- src/bot
npm test -w @aoe/sim
npm test -w @aoe/protocol
npm test -w @aoe/server

# Nếu timeout do tải/concurrency: chẩn đoán, chạy riêng test fail rồi giới hạn worker;
# không tăng timeout hay skip để che assertion sai. Ghi cả lượt fail và rerun.
npm test --workspaces --if-present -- --maxWorkers=2

# E2E hiện có, filter cụ thể để tránh tên thư mục vô tình match toàn suite
npm run test:e2e -- 'tests/(lobby|lobby-settings|farm|research|game-speed|determinism)\.spec\.ts$'

# Sau khi các spec mới đã được tạo
npm run test:e2e -- 'tests/single-player-(setup|pause|speed|progression)\.spec\.ts$'

# Soak chỉ một job sở hữu port, ghi seed vào báo cáo
$env:SOAK_SEED = '20261124'
$env:SOAK_MINUTES = '20'
npm run test:soak
```

Kiểm tra trước khi chạy E2E rằng port 5273/8887 không thuộc phiên khác; trên Windows có thể dùng `Get-NetTCPConnection`. Không tự kill process của người dùng. Các config hiện tại đã thiết lập synthetic pack và tự build/serve; không tự thay asset thật để chạy suite này.

`e2e/tests/soak.spec.ts` hiện có bot fuzz riêng: **pass soak hiện tại chưa chứng minh AiBot mới đã được stress**. T12 phải thêm hoặc cấu hình kịch bản chạy AiBot thực với profile/seed, kiểm tra trước rằng agent đang test đúng bot production. Không thay bot production bằng fuzz bot rồi ghi nhận đạt.

Soak đề xuất nghiệm thu: tối thiểu 3 seed cố định được ghi lại, đủ ba profile, map land và map có vùng tách biệt; ghi rõ các trận kết thúc sớm theo victory và cách cộng thời lượng theo config. Đây là ngân sách nghiệm thu đề xuất, không cam kết thời gian hoàn tất trên máy cụ thể.

## Báo cáo nghiệm thu tối thiểu

Ghi commit, Node/tool versions liên quan, command nguyên văn, exit code, pass/fail/skip, seed/map/civ/profile, pack synthetic/thật, error đầu tiên và artifact/log. So sánh hash ở **cùng turn**, không cùng thời điểm wall clock. World time phải đứng yên khi paused; thứ tự control event phải tái hiện được khi kiểm tra reconnect.

Chỉ DONE khi task có review và tests thực. Nếu không có pack gốc hoặc browser engine, báo giới hạn cụ thể; không gọi test skip là pass. Không phát hành hoặc deploy chỉ vì bộ test này hoàn thành.
