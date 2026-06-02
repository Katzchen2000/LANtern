import React, { useMemo } from 'react';
import katex from 'katex';

interface LatexRendererProps {
  text?: string;
  className?: string;
}

export const LatexRenderer: React.FC<LatexRendererProps> = ({ text = '', className = '' }) => {
  const renderedElements = useMemo(() => {
    if (!text) return null;

    // Split text into math segments vs plain segments.
    // Group 1: block math $$...$$
    // Group 2: inline math $...$ (assuring it is not a normal money pattern like $30 or $40)
    const regex = /(\$\$(?:[\s\S]+?)\$\$|\$(?!\s)[^\$\n]+?(?<!\s)\$)/g;
    const parts = text.split(regex);

    return parts.map((part, index) => {
      // Check if it's block math
      if (part.startsWith('$$') && part.endsWith('$$')) {
        const formula = part.slice(2, -2).trim();
        try {
          const html = katex.renderToString(formula, {
            displayMode: true,
            throwOnError: false,
          });
          return (
            <div
              key={index}
              className="py-3 px-4 my-2 overflow-x-auto bg-black/10 rounded-xl max-w-full text-center"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          );
        } catch (error) {
          console.error('KaTeX block error:', error);
          return <pre key={index} className="text-red-400 p-2 text-xs">{part}</pre>;
        }
      }

      // Check if it's inline math
      if (part.startsWith('$') && part.endsWith('$')) {
        const formula = part.slice(1, -1).trim();
        try {
          const html = katex.renderToString(formula, {
            displayMode: false,
            throwOnError: false,
          });
          return (
            <span
              key={index}
              className="inline-block px-0.5"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          );
        } catch (error) {
          console.error('KaTeX inline error:', error);
          return <code key={index} className="text-red-400 text-xs">{part}</code>;
        }
      }

      // Plain text gets rendered normally
      return <span key={index} className="whitespace-pre-wrap select-text">{part}</span>;
    });
  }, [text]);

  return <div className={`leading-[1.8] font-medium tracking-wide ${className}`}>{renderedElements}</div>;
};
