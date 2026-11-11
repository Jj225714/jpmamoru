import { FileText, ImagePlus, Images, Maximize2, Settings2, ShoppingBag, Video } from "lucide-react";

export const navigationTools = [
    {
        slug: "canvas",
        icon: Maximize2,
    },
    {
        slug: "image",
        icon: ImagePlus,
    },
    {
        slug: "commerce",
        icon: ShoppingBag,
    },
    // TEMP_HIDDEN_HEADER: 视频创作台入口，恢复时取消此块注释（页面路由仍保留）。
    /*
    {
        slug: "video",
        icon: Video,
    },
    */
    {
        slug: "prompts",
        icon: FileText,
    },
    {
        slug: "assets",
        icon: Images,
    },
    {
        slug: "config",
        icon: Settings2,
    },
] as const;

export type NavigationToolSlug = (typeof navigationTools)[number]["slug"];
