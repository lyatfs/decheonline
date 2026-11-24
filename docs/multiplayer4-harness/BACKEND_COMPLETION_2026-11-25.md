# Hoàn thiện logic backend M00–M04 — 2026-11-25

Yêu cầu mới nhất: bổ sung mã backend Antigravity còn dở; không phải biên dịch. Lần này chỉ sửa backend và test hồi quy liên quan, không thay UI/launcher, không chạy build, không kiểm thử song song, không commit/push hoặc restart server đang chạy.

## Mã đã bổ sung trong lần tiếp tục

`apps/server/src/rooms.ts`:

1. **Kết thúc khi không còn active sender:** tập bỏ phiếu bình thường vẫn là mọi active participant. Khi tất cả đã resign/drop, các participant gốc còn kết nối có thể xác nhận kết quả thực từ World. Không biến observer thành sender, không tạo lượt rỗng vô hạn và không cho join lại thành người mới.
2. **Chặn báo kết quả trước khi áp dụng đầu hàng:** `resultNotBefore` lấy lượt resign được accepted/inject cộng `COMMAND_DELAY_TURNS`. Xóa votes khi thay đổi gameplay quorum, yêu cầu report đã được client xác nhận chạy và nằm trong timeline relay đã cấp.
3. **Theo dõi observer tiến tới lượt cuối:** `Member.executedTurn` phân biệt tiến độ simulation với cursor batch `nextTurn`. Keepalive rỗng của observer chỉ xác nhận lượt có thể thực thi; không sửa accepted batches/telemetry hoặc mở lại quyền điều khiển.
4. **Không mất evidence checksum:** giữ sample đã so trong cửa sổ có giới hạn để kiểm tra `result.hash`; report không được mâu thuẫn với checksum của chính peer. Pruning giữ bộ nhớ hữu hạn như trước.
5. **Mutation nguyên tử:** validate turn/frameMs/quyền/tốc độ trước khi lưu telemetry. Gói duplicate, sai thứ tự hoặc tốc độ không hợp lệ không thể thay frameMs dùng tính G/F.
6. **Không treo ở terminal frontier:** nếu observer cuối chưa bỏ phiếu rời sau khi các observer khác đã gửi phiếu cuối trùng nhau, `completeAgreedResult` kiểm tra ngay tập còn kết nối. Giữ phiếu terminal đã hợp lệ trong trường hợp chỉ mất observer, vì không còn endTurn mới để client gửi lại. Gameplay quorum đổi vẫn xóa toàn bộ votes và nâng mốc thời gian.

## Kiểm tra và review

Các test đều chạy tuần tự với `--maxWorkers=1`; không có test runner song song.

- Ca mới ban đầu:3fail/1pass, chứng minh thiếu kết thúc toàn-resigned, chấp nhận kết quả sớm và telemetry bị batch sai thay đổi.
- Thêm regression proof checksum và terminal nonvoter departure. Reviewer phát hiện nguy cơ treo do xóa votes ở lượt cuối; regression tái hiện1fail/5pass trước sửa.
- Sau sửa cuối: `npm test -w @aoe/server -- --maxWorkers=1` — **exit0,103/103 tests,9/9 files**.
- `npm run typecheck -w @aoe/server` — **exit0** sau sửa cuối.
- Reviewer `mp4_review` đọc độc lập liveness/quorum/timeline/checksum/telemetry; xác nhận không còn finding mức quan trọng trong phần sửa này. Reviewer không chạy test/build.
- Log: `C:/Users/Admin/Documents/ChatGPT/SangNguyen/mp4-backend-final-tests.log`, `mp4-backend-final-types.log`. Evidence đỏ: `mp4-backend-completion-red.log`, `mp4-terminal-liveness-red.log`.

`apps/server/src/multiplayer4-completion.test.ts` có6 ca mới. Hai expectation lifecycle cũ đã được sửa để chỉ chấp nhận report ở turn3 sau resign issued turn1, thay vì report turn0 trước hiệu lực của lệnh.

## Trạng thái task

M00 contracts/baseline, M01 protocol, M02 membership, M03 relay/rejoin và M04 lifecycle/result đã có mã tích hợp; lần này đóng phần backend còn dở của M04 và tính nguyên tử batch của M03. tasks.json đánh dấu M00–M04 DONE dựa source, focused verification và review đã ghi nhận, **không dựa thành công build**.

M05–M14 không được nghiệm thu lại trong lần này. Antigravity đã có source cho nhiều phần trong đó; vẫn cần kiểm tra riêng trước khi đổi trạng thái. Kết quả này chưa chứng minh bốn browser/thiết bị, LAN hay Internet thật đã được nghiệm thu. Báo cáo BUILD_STATUS_2026-11-25.md là snapshot trước lần sửa backend này.
