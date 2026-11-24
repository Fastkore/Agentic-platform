import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { hideAttachedOutputLinks } from './chat-markdown';

export const ChatMarkdown = memo(function ChatMarkdown({ text, origin, files }: {
  text: string; origin: string; files?: readonly { name: string }[];
}) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}
    rehypePlugins={files ? [[hideAttachedOutputLinks, { origin, files }]] : undefined}
    components={{
      img: ({ alt }) => <span>[Изображение: {alt}]</span>,
      a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
    }}>{text}</ReactMarkdown></div>;
});
