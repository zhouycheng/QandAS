import { RichContent } from './rich-content'
export function AnnouncementBody({ text }: { text: string }) { return <RichContent text={text} format="MARKDOWN" /> }
