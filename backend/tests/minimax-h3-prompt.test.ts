import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileH3Prompt } from '../src/services/adapters/minimax-h3-prompt.js'

test('H3 prompt compiler: compiles multi-shot, lip-sync dialogue, frame alignment, and subject mapping', () => {
  const result = compileH3Prompt({
    prompt: `【镜头1】@小明 坐在书桌前思考，微笑着抬起头。
对白：终于把这个程序写好了！
【镜头2】窗外阳光明媚，鸟儿飞过。`,
    duration: 6,
    hasFirstFrame: true,
    hasLastFrame: true,
    referenceImageCount: 2,
    referenceNames: ['小明', '书房'],
    atmosphere: '轻松愉悦',
  })

  // 1. 首尾帧对齐
  assert.match(result, /<Picture 1> aligned at 0\.00s/)
  assert.match(result, /<Picture 2> aligned at 6\.00s/)

  // 2. 主体声明
  assert.match(result, /<Subject 1> \(Character\): \[Image 1\] 小明/)
  assert.match(result, /<Subject 2> \(Character\): \[Image 2\] 书房/)

  // 3. 分镜头标记标准化
  assert.match(result, /\[Shot 1\]/)
  assert.match(result, /\[Shot 2\]/)
  assert.doesNotMatch(result, /【镜头1】/)

  // 4. @小明 转译为 [Image 1] 小明
  assert.match(result, /\[Image 1\] 小明 坐在书桌前思考/)

  // 5. 原生对白音画口型同步
  assert.match(result, /<d>\[Chinese\] 小明: "终于把这个程序写好了！" <\/d>/)

  // 6. 音效与氛围
  assert.match(result, /overall_soundscape: 轻松愉悦/)
})

test('H3 prompt compiler: normalizes legacy Ali @图片1 format', () => {
  const result = compileH3Prompt({
    prompt: '@图片1李雷 正在和 @图片2韩梅梅 说话\n李雷: "很高兴认识你"',
    referenceImageCount: 2,
    referenceNames: ['李雷', '韩梅梅'],
  })

  assert.match(result, /\[Image 1\] 李雷 正在和 \[Image 2\] 韩梅梅 说话/)
  assert.match(result, /<d>\[Chinese\] 李雷: "很高兴认识你" <\/d>/)
})

test('H3 prompt compiler: respects existing H3 tags without duplicating', () => {
  const custom = `<Picture 1> aligned at 0.00s
<Subject 1> (Character): [Image 1] Alice
[Shot 1]
Alice smiles.
<d>[Chinese] Alice: "Hello world" </d>`

  const result = compileH3Prompt({
    prompt: custom,
    hasFirstFrame: true,
    referenceImageCount: 1,
    referenceNames: ['Alice'],
  })

  // 不应重复插入 <Picture 1> 或 <Subject 1>
  assert.equal((result.match(/<Picture 1>/g) || []).length, 1)
  assert.equal((result.match(/<Subject 1>/g) || []).length, 1)
  assert.equal((result.match(/<d>/g) || []).length, 1)
})
