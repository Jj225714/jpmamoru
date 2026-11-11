import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { resolveModelChannel, useEffectiveConfig } from "@/stores/use-config-store";
import type { Task } from "@/services/api/task-center";
import { taskClient, taskLink, taskSources, useTaskSessionRevision, type TaskSource } from "./session";
import { stageLabel, taskStatusLabels } from "./presentation";

export function CurrentImageTasks() {
    const revision = useTaskSessionRevision(), config = useEffectiveConfig();
    const channel = resolveModelChannel(config, config.imageModel || config.model);
    const source = taskSources().find(item => item.session.channelId === channel.id && item.target.provider === "gpt");
    return <div className="border-b border-stone-200 px-3 py-2 text-xs dark:border-stone-800"><Link to={source ? taskLink(source.id) : "/tasks"} className="font-medium">任务中心 · 查看服务端进度与结果</Link>{source ? <CurrentItems key={`${revision}:${source.id}`} source={source} /> : null}</div>;
}
function CurrentItems({ source }: { source: TaskSource }) {
    const [items, setItems] = useState<Task[]>([]), [error, setError] = useState("");
    useEffect(() => {
        let stopped = false, timer: ReturnType<typeof setTimeout>;
        let client: ReturnType<typeof taskClient>;
        try { client = taskClient(source); } catch { setError("当前渠道无法查询任务"); return; }
        const read = async () => {
            try { const page = await client.list({ limit: 3 }); if (!stopped) { setItems(page.items); setError(""); } }
            catch { if (!stopped) setError("任务查询暂不可用，请在任务中心继续查询原任务"); }
            if (!stopped) timer = setTimeout(read, 10000);
        };
        void read();
        return () => { stopped = true; clearTimeout(timer); client.dispose(); };
    }, [source.id, source.session.revision]);
    return <div>{error ? <p role="status">{error}</p> : null}{items.map(item => <p key={item.jobId} className="mt-1"><Link to={taskLink(source.id, item.jobId)}>{item.jobId.slice(0, 12)} · {taskStatusLabels[item.status]} · {stageLabel(item.progress.stage)}</Link></p>)}</div>;
}
