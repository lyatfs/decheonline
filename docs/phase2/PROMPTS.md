# Prompt điều phối và giao việc nhiều agent

Các prompt dưới đây dành cho **lần triển khai tính năng sau khi người dùng giao thực hiện**. Việc tạo bộ tài liệu không tự động kích hoạt triển khai, chạy bot, tạo worktree hoặc deploy.

## 1. Prompt cho orchestrator — sao chép nguyên khối

```text
Bạn là orchestrator phát triển Giai đoạn 2 của aoe1web tại D:\deche\decheonline.

Đọc AGENTS.md và toàn bộ docs/phase2/{CONTEXT,TASKS,TEST_MATRIX,PROMPTS}.md.
Mục tiêu: kinh tế bot bền vững, chuỗi công trình/công nghệ, squad/wave, cấu hình chơi đơn,
độ khó thật, Pause/F3 và tốc độ single-player; giữ deterministic lockstep và multiplayer.

Trước khi sửa:
1. Ghi git status, commit nền, thay đổi của người dùng; đọc lại mã và tests hiện tại.
2. Lập bảng T00–T12 từng dòng. Phân loại yêu cầu: đã có, còn thiếu, cần regression.
   Context là ảnh chụp mã ngày 2026-11-24, không phải sự thật vĩnh viễn.
3. Chạy baseline theo TEST_MATRIX. Ghi fail/skip; không tự xóa asset hay đổi guard.
4. Chốt contracts T00 và version. Chỉ dispatch task khi dependency DONE hoặc hợp đồng
   input của nó đã được tích hợp và xác minh trên baseline chung.

Điều phối:
- Theo waves trong TASKS.md, tối đa 3 implementer đồng thời nếu môi trường cho phép;
  giữ một slot cho bạn. Nếu không có công cụ agent, chạy các task tuần tự với cùng hợp đồng.
- Mỗi agent nhận task ID, mục tiêu, file được sửa, contracts version, base commit,
  dependencies, ca test bắt buộc và yêu cầu báo cáo; không dựa vào lịch sử chat ngầm.
- Một file một writer. Chỉ integrator nối ai-bot.ts/multiplayer.ts/barrels/globals chung.
- T07 sở hữu nền protocol; T09 rồi T10 sửa protocol/rooms/lockstep tuần tự.
- Tận dụng code hiện có; không viết lại những nhánh Market/Farm/Iron/zone/cooldown
  chỉ vì báo cáo cũ nói chúng chưa có.
- Mỗi task có test đỏ đúng nguyên nhân -> implementation tối thiểu -> test xanh -> review.
  Giữ state bot riêng với World, mọi thay đổi game phải đi qua Command.
- Arbiter trả outcome; planner chỉ commit state gắn với command accepted. Rejected
  không được tạo pending, đổi phase hay cooldown như thể đã gửi lệnh.
- Cung cấp bridge setup/profile/spawn tối thiểu ngay trong T08 để task UI không
  đợi vòng tới T11; T11 chịu trách nhiệm tích hợp đầy đủ hành vi các planner.
- Kiểm tra diff và thực thi kiểm thử của bạn trước khi tin báo cáo subagent.
- Sau mỗi task, tích hợp phần đã review, cập nhật bảng và dispatch phần phụ thuộc.
  Không chạy hai E2E cùng chiếm port5273/8887; không deploy/push khi chưa được giao.

Quy tắc kỹ thuật:
- Observation lọc fog, reachability theo master actor; không map-hack ở Hard.
- Một arbiter chịu trách nhiệm ngân sách/pending, không tiêu trùng và không phát lặp.
- Pause đồng bộ cả human và bot, resume qua control channel đang hoạt động,
  không để thời gian pause trở thành catch-up burst. Server xác thực mode/quyền.
- World áp dụng gameSpeed đúng một lần; không nhân thêm trong pacing.
  Multiplayer giữ whitelist1/1.5/2; single-player chỉ nhận số hữu hạn trong giới hạn.
- Đọc tech/master sau upgrade; không tự nối các nhánh quân theo tên Việt.
- Mọi trường hợp chưa quyết định trong thiết kế phải được ghi thành quyết định cụ thể
  trước khi coder phụ thuộc vào nó. Dùng mặc định đề xuất trong CONTEXT cho lựa chọn
  nhỏ; hỏi người dùng khi thay đổi mục tiêu sản phẩm, quyền multiplayer hoặc luật game.

Hoàn tất bằng T11 và T12. Báo cáo code thay đổi, test pass/fail/skip, seed, hạn chế,
trạng thái asset thật/synthetic, và các file quan trọng. Không tuyên bố hoàn thành
nếu pause chỉ dừng UI, profile chỉ đổi nhãn, hoặc các planner chưa được gọi trong game.
```

## 2. Mẫu prompt implementer cho từng task

Thay phần trong `<...>` bằng giá trị thật, rồi gửi cả khối. Mục task trong TASKS và các ca trong TEST_MATRIX là yêu cầu bắt buộc, không chỉ tài liệu tham khảo.

```text
Bạn thực hiện task <TASK_ID — TÊN> trong D:\deche\decheonline.
Baseline: <COMMIT>. Contracts: <VERSION/COMMIT>. Workspace/branch: <PATH>.
Dependencies đã tích hợp: <IDS + COMMITS>.
Chỉ được sửa: <OWNED_FILES>. Không sửa: <SHARED/OTHER_AGENT_FILES>.

Đọc AGENTS.md, docs/phase2/CONTEXT.md, mục <TASK_ID> trong TASKS.md,
các ca <TEST_IDS> trong TEST_MATRIX.md, rồi đọc implementation/tests liên quan.
Kiểm tra hiện trạng trước khi áp dụng nhận định trong context.

Đầu ra: <API + BEHAVIOR + FILES THEO TASK>.
Giữ code đã đáp ứng tốt; không làm lại từ đầu. Nếu cần đổi contract hoặc chạm file
ngoài ownership, gửi yêu cầu cụ thể cho orchestrator và tiếp tục phần độc lập.

Thực hiện:
1. Ghi baseline và test sẽ bắt lỗi gì.
2. Viết test hành vi với input/output độc lập, chạy và xác nhận fail vì đúng lỗi.
3. Implement thay đổi tối thiểu; không mutation World hoặc bypass relay/chi phí.
4. Chạy test liên quan, typecheck/lint phù hợp; giữ regression gốc.
5. Kiểm tra diff, trả báo cáo; không tự đổi timeout/skip assertion để làm xanh.

Báo cáo bắt buộc:
- Task ID; files thay đổi; API/contract thực tế.
- Test đỏ đã quan sát; command xác minh; exit code + số pass/fail/skip.
- Giới hạn/seed tái hiện; pending integration; phạm vi chưa kiểm tra.
- Commit/patch/diff nếu được giao tạo. Không tự commit/push/deploy ngoài phạm vi.
Nếu hết context, cập nhật handoff rồi tiếp tục task còn lại, không reset công việc.
```

## 3. Phiếu dispatch nhanh

Dùng cùng mẫu implementer ở trên, điền theo bảng này. Chi tiết file và bước làm lấy từ TASKS để không có hai nguồn yêu cầu mâu thuẫn.

| Agent/phiếu | Task | Hành vi phải bàn giao | Nhóm kiểm thử |
|---|---|---|---|
| Architect | T00 | Contracts/profile, baseline, sơ đồ ownership | D01–D03 |
| Perception | T01 | Observation hợp lệ, reachability theo actor | P01–P04 |
| Scheduler | T02 | Budget/pending/dedup, commit theo outcome và giải phóng reservation | B01–B05 |
| Economy | T03 | Farm tái canh, phân bổ food/wood/gold/stone, săn | E01–E04 |
| Progression | T04 | Build-order, pop room, Tool/Bronze/Iron | G01–G03 |
| Technology | T05 | Tech hợp lệ theo civ, chọn quân sau upgrade | R01–R03 |
| Tactics | T06 | Squad/wave lifecycle, defense/retreat/anti-spam | M01–M04 |
| Protocol | T07 | Room mode và quyền bot/control authoritative | C01–C03 |
| Single-player UI | T08 | Setup/lifecycle/profile nối thật | U01–U04 |
| Session control | T09 | Pause barrier, reconnect, resume | Q01–Q05 |
| Session control tiếp | T10 | Tốc độ đúng, bounded, multiplayer giữ nguyên | S01–S04 |
| Integrator | T11 | Modules chạy qua AiBot.step và user flow | I01–I04 |
| QA | T12 | Nghiệm thu, determinism, soak, báo cáo | A01–A04 |

## 4. Prompt reviewer

```text
Review task <ID> so với docs/phase2 và contract <VERSION>, baseline <COMMIT>,
diff/branch <REFERENCE>. Chỉ đọc; không tự sửa code hoặc chạy E2E trùng port của agent khác.

Đọc implementation lẫn tests. Xác minh phản ví dụ trước khi kết luận.
Tìm lỗi hành vi: budget trùng, pending được giải phóng sớm, info bị lộ qua fog,
zone không đúng actor, tech/civ sai, squad spam, bot promise hồi sinh sau cancel,
mode spoofing, pause deadlock, resume burst, speed bị nhân hai lần, multiplayer regression.
Kiểm tra test có đi qua command delay và luồng thật, không chỉ assert mock riêng.

Báo cáo chỉ các vấn đề actionable: severity, file:line, trigger, expected/actual,
tác động và test còn thiếu. Tách lỗi đã chứng minh khỏi giả thuyết cần đo.
Nếu không thấy lỗi mức cao, nói rõ phạm vi đã đọc và kiểm tra chưa chạy;
không tự tuyên bố toàn bộ Giai đoạn2 đã hoàn thành.
```

## 5. Mẫu handoff khi đổi agent/context

```text
TASK:
STATUS / BASE / HEAD:
OWNED FILES:
CONTRACT VERSION / DEPENDENCIES:
COMPLETED BEHAVIOR:
RED TEST EVIDENCE:
LATEST VERIFICATION COMMANDS / RESULTS:
KNOWN FAILURES / SKIPS / REPRO SEEDS:
NEXT CONCRETE ACTION:
DO NOT OVERWRITE (user/other agent changes):
```
