"use client";
import Image from "next/image";
import { useState } from "react";
import { instagramPhotoUrl } from "@/lib/channels/instagram-profile-data";

export function CustomerAvatar({
  photoUrl,
  fallback,
}: {
  photoUrl?: string;
  fallback: string;
}) {
  const photo = instagramPhotoUrl(photoUrl);
  return (
    <AvatarImage key={photo ?? "fallback"} photo={photo} fallback={fallback} />
  );
}
function AvatarImage({
  photo,
  fallback,
}: {
  photo?: string;
  fallback: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface">
      {photo && !failed ? (
        <Image
          src={photo}
          alt=""
          width={40}
          height={40}
          unoptimized
          referrerPolicy="no-referrer"
          className="h-10 w-10 object-cover outline outline-1 -outline-offset-1 outline-black/10"
          onError={() => setFailed(true)}
        />
      ) : (
        <Image src={fallback} alt="" width={24} height={24} />
      )}
    </span>
  );
}
