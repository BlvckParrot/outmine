/** Shared shell for the written pages. Tailwind's typography plugin would be a
 *  dependency for four pages of text; three rules are enough. */
export function Prose(props: { title: string; children: React.ReactNode }) {
  return (
    <article className="mt-8 space-y-4 text-sm leading-relaxed text-zinc-400 [&_a]:text-emerald-400 [&_a:hover]:underline [&_h2]:mt-8 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:uppercase [&_h2]:tracking-widest [&_h2]:text-zinc-500 [&_li]:ml-5 [&_li]:list-disc [&_strong]:text-zinc-200">
      <h1 className="text-2xl font-bold text-white">{props.title}</h1>
      {props.children}
    </article>
  );
}
