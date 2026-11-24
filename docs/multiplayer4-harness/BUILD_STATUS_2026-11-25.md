# Bàn giao bản build multiplayer4 — 2026-11-25

Repository: `D:/deche/decheonline`, baseline `7b4da47917bce4be0dd6d9f6aaf92414b773225a`, branch `sang`.

## Kết quả theo yêu cầu mới nhất

Người dùng yêu cầu chỉ build, chưa kiểm thử song song. Đã dừng các worker kiểm thử; không chạy thêm test, typecheck, lint hay E2E sau chỉ dẫn này. Không khởi chạy/restart server người dùng trên cổng8787, không bật tunnel, không commit/push.

`npm run build` tại repo: **exit0**. Vite build client và esbuild build server thành công. Artifacts:

- `apps/client/dist/index.html` và `apps/client/dist/bundle/`.
- `apps/server/dist/main.js`.
- Log: `C:/Users/Admin/Documents/ChatGPT/SangNguyen/mp4-build-2026-11-25.log`.

Vite cảnh báo một số JS chunks lớn hơn500kB; build vẫn thành công. Build không bao gồm kiểm tra TypeScript toàn repo hoặc chứng minh runtime/asset/LAN sẵn sàng.

## Phần logic đã tiếp tục hoàn thiện

- M00: contracts `mp4-v1` đã freeze trong CONTRACTS.md; baseline và thay đổi user được giữ nguyên. M01 protocol capacity2/4, stable slots, manifest/versions và result reports đã tích hợp, được review trước lần gián đoạn.
- M02: Member.slot cố định, hostSlot là role riêng, lowest-free-seat join, room2/single-player2 và room4 đủ4 Ready, version gate trước mutation. Chat reject toàn danh sách nếu có recipient không thuộc capacity/membership, không gửi một phần.
- M03: relay batch ordered, checksum cùng turn/không dùng missing0 khi so, bounded reports, RTT từ hai leg active lớn nhất; token/slot/manifest/replay khi rejoin.
- M04: leave/timeout inject resign sau toàn bộ batch đã accepted, không kết thúc trận của người còn lại; bỏ người resign/drop khỏi wait set; finite release khi mọi sender inactive; dọn room/timer khi socket cuối rời. Result agreement cùng turn/hash/winners từ mọi active peer mới phát completed. Client gửi kết quả từ World, resend khi rejoin, completed giữ màn hình kết quả.
- Sửa tích hợp Antigravity: fingerprint HTML sau stamp khớp server, stamp idempotent; app dùng cùng version authority với RoomRegistry được inject và reject cấu hình mâu thuẫn.
- Sửa fixture mới của Antigravity: Nomad1 dân theo luật đã có; Gaia có LOS tài nguyên riêng nhưng không chia sẻ; movement được quan sát sau khi action có bước chạy; so syncChecksum khi pending queue có arrival order khác và full hash sau khi drain. Sửa mocks HUD/startup theo DOM/asynchronous semantics. Main Playwright config bỏ soak4 khỏi run mặc định.

## Evidence có trước yêu cầu dừng kiểm thử

- Protocol121/121; focused client lockstep34/34.
- Sim4 fixture files28/28; focused client multiplayer/HUD19/19; hosting9/9.
- Worker server báo fullserver94/94, focused lint và server typecheck exit0 trước hai regression cuối.
- Sau đó worker thêm regression duplicate/stale result và observer checksum: lifecycle13pass/1fail chỉ ra observer đã resign vẫn gửi hash bị bad-turn. Đã sửa bằng early return cho resigned/dropped; **sửa cuối chưa rerun vì người dùng yêu cầu chỉ build**.
- Một lượt root check trước sửa còn fail do lifecycle/fingerprint/fixtures và timeout; không coi lượt đó là green. Launcher/tunnel fixture run đang dở đã dừng, không có kết luận pass.

M00/M01 có review trước đó. M02–M04 source đã tích hợp/build nhưng giữ REVIEW vì chưa nghiệm thu cuối. Không dùng thành công build để đổi mọi task thành DONE.

## Việc còn lại khi được giao kiểm thử

1. Chạy lại server lifecycle mới nhất và root check. Máy nhiều worker từng timeout; Vitest tại repo hỗ trợ `VITEST_MAX_WORKERS=2` nếu cần giới hạn concurrency, không sửa test timeout để che lỗi.
2. Hoàn tất review M03/M04, xác nhận observer hash regression và các round consensus.
3. Kiểm tra launcher/tunnel tests và production fingerprint trên artifact thật. Launcher fallback khi `/api/versions`404 chưa được audit xong.
4. Antigravity đã thêm source M05–M13 (lobby/invite,sim4/HUD,launcher,versions,E2E) nhưng trạng thái TODO của harness chưa phải chứng minh đã nghiệm thu. Cần xác nhận từng task trước khi DONE.
5. Chưa chạy E2E4, soak/cross-engine, bốn thiết bị LAN hoặc Internet thật. Không tuyên bố runtime/sharelink đã nghiệm thu chỉ dựa build.

Giữ nguyên toàn bộ assets untracked có trước và các thay đổi Antigravity đã có. Không chạy lại script staging cũ để ghi đè source hiện tại.
