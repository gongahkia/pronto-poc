import Image from 'next/image';

export function BusinessLogo({name,logoPath,className='h-8 w-14'}:{name:string;logoPath:string|null;className?:string}){
 const initials=name.split(/\s+/).filter(Boolean).slice(0,2).map(word=>word[0]?.toUpperCase()).join('');
 return <span className={`flex shrink-0 items-center justify-center rounded-md bg-white p-1 text-sm font-semibold text-slate-800 ${className}`}>
  {logoPath?<Image src={logoPath} alt={name} width={48} height={24} className="h-auto w-full object-contain"/>:initials}
 </span>;
}
