import Link from "next/link";
import { BASE_PATH } from "@/components/basePath";

export function Brand() {
  return (
    <Link href="/home" className="brand">
      {/* eslint-disable-next-line @next/next/no-img-element -- static product mark */}
      <img className="brand-mark" src={`${BASE_PATH}/openfloor-mark.png`} alt="" aria-hidden="true" />
      OPENFLOOR
    </Link>
  );
}
