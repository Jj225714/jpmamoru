import { Drawer } from "antd";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { navigationTools, type NavigationToolSlug } from "@/constant/navigation-tools";
import { cn } from "@/lib/utils";

type MobileNavDrawerProps = {
    open: boolean;
    activeToolSlug?: NavigationToolSlug;
    onClose: () => void;
};

export function MobileNavDrawer({ open, activeToolSlug, onClose }: MobileNavDrawerProps) {
    const { t } = useTranslation();

    return (
        <Drawer title={t("topNav.navigation")} placement="left" size={280} open={open} onClose={onClose} className="md:hidden">
            <div className="space-y-1">
                <Link to="/tasks" onClick={onClose} className="block rounded-lg px-3 py-3 text-base">任务中心</Link>
                {navigationTools.map((tool) => {
                    const Icon = tool.icon;
                    const active = tool.slug === activeToolSlug;
                    return (
                        <div key={tool.slug}>
                            <Link
                                to={`/${tool.slug}`}
                                onClick={onClose}
                                className={cn(
                                    "flex items-center gap-3 rounded-lg px-3 py-3 text-base transition",
                                    active ? "bg-stone-100 font-medium text-stone-950 dark:bg-stone-800 dark:text-stone-100" : "text-stone-600 hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-stone-800 dark:hover:text-stone-100",
                                )}
                            >
                                <Icon className="size-5" />
                                <span>{t(`navigation.${tool.slug}`)}</span>
                            </Link>
                            {tool.slug === "image" && (
                                <Link to="/image?mode=advanced" onClick={onClose} className="ml-8 block rounded-lg px-3 py-2 text-sm text-violet-600">
                                    高级通用生图
                                </Link>
                            )}
                        </div>
                    );
                })}
            </div>
        </Drawer>
    );
}
