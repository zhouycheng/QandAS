import { RichContent } from '../../components/rich-content'
import { Space, Tag, Typography } from '@arco-design/web-react'
import { questionTypeLabels } from '../../lib/labels'
import { answerSummary } from '../../lib/question-content'
import { QuestionImages } from '../../components/question-images'
import type { QuestionContent } from '../../types/admin'

export function QuestionContentView({ question, stage = 'review' }: { question: QuestionContent; stage?: 'answer' | 'feedback' | 'review' }) {
  const reveal = stage === 'review' || (stage === 'feedback' && question.type !== 'SHORT_ANSWER')
  const body = (text?: string) => <RichContent text={text || ''} format={question.contentFormat || 'PLAIN_TEXT'} />
  return <div className="bw-content-view">
    {!!question.assetIds?.length && <QuestionImages ids={question.assetIds} />}
    <section><Typography.Title heading={6}>{question.type === 'READING' ? '题组标题' : '题干'}</Typography.Title><RichContent text={question.stem} format={question.type === 'READING' ? 'PLAIN_TEXT' : question.contentFormat} blanks={question.type === 'FILL_BLANK' ? (question.blanks || []).map(blank => reveal ? blank.answers[0] || '' : '') : undefined} /></section>
    {question.type === 'READING' ? <>
      <section className="bw-reading-material"><Typography.Title heading={6}>阅读材料</Typography.Title>{body(question.passage)}</section>
      {question.subQuestions?.map((sub, index) => <section className="bw-reading-sub" key={sub.id}><div className="bw-sub-heading"><strong>小题 {index + 1}</strong><Tag>{questionTypeLabels[sub.type]}</Tag></div><QuestionContentView question={sub} stage={stage} /></section>)}
    </> : question.type === 'FILL_BLANK' ? <section>{!reveal && <p>{question.blanks?.length} 个空 · 作答时隐藏参考答案</p>}{reveal && <>
      <Typography.Title heading={6}>各空可接受答案</Typography.Title>
      {question.blanks?.map((blank, index) => <div className="bw-blank-answer" key={index}>{question.blanks!.length > 1 && <strong>{String.fromCharCode(9312 + index)}</strong>}<Space wrap>{blank.answers.map((answer) => <Tag color="green" key={answer}>{answer}</Tag>)}</Space></div>)}
      <p className="muted">{question.blankMatch?.ignoreCase ? '忽略英文字母大小写' : '区分英文字母大小写'} · {question.blankMatch?.trimWhitespace ? '忽略首尾空格' : '保留首尾空格参与匹配'}</p></>}
    </section> : question.type === 'SHORT_ANSWER' ? <><Tag>不计分</Tag>{reveal && <>
      <section><Typography.Title heading={6}>{question.presentation === 'CODE_WRITING' ? '参考实现' : '参考思路'}</Typography.Title>{body(question.referenceAnswer)}</section>
      <section><Typography.Title heading={6}>参考要点 · 可选自评</Typography.Title><ol>{question.scoringPoints?.map((point, i) => <li key={i}>{body(point)}</li>)}</ol></section></>}
    </> : <section><Typography.Title heading={6}>选项与答案</Typography.Title><Space direction="vertical" style={{ width: '100%' }}>
      {question.options.map((option) => <div className={`detail-option ${reveal && question.correctAnswer.includes(option.key) ? 'detail-option-correct' : ''}`} key={option.key}><Tag color={reveal && question.correctAnswer.includes(option.key) ? 'green' : 'gray'}>{option.key}</Tag>{body(option.content)}</div>)}
      {reveal && <p>{answerSummary(question)}</p>}
    </Space></section>}
    {reveal && <section><Typography.Title heading={6}>{question.type === 'READING' ? '材料说明' : '答案解析'}</Typography.Title>{body(question.explanation)}</section>}
  </div>
}
