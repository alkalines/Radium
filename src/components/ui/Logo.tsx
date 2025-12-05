import Image from "next/image";

interface ExtendedLogoProps {
    size?: "sm" | "md" | "lg";
}

const sizeMap = {
    sm: { width: 80, height: 21 },
    md: { width: 120, height: 32 },
    lg: { width: 160, height: 43 },
};

export function ExtendedLogo({ size = "md" }: ExtendedLogoProps) {
    const { width, height } = sizeMap[size];
    return <Image src="/radium_extended.svg" alt="Logo written Radium" width={width} height={height} />;
}