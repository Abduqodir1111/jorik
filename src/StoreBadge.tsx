import { BookOpen } from "lucide-react";
export default function StoreBadge({name,color}:{name:string;color?:string}) {
  const brand = name.toUpperCase().includes("STOREBOOKS") ? "storebooks" : name.toUpperCase().includes("MANGASTORE") ? "mangastore" : "other-store";
  return <span className={`store-badge account-badge ${brand}`} style={color ? {color} : undefined}><BookOpen size={12} aria-hidden="true"/><span>{name}</span></span>;
}
