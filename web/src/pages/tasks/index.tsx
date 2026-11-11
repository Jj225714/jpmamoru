import { useEffect, useState, useSyncExternalStore } from "react";
import { Alert, Button, Empty, Select, Tag } from "antd";
import { Link, useSearchParams } from "react-router-dom";
import type { Task } from "@/services/api/task-center";
import { TaskBoard } from "./board";
import { taskClient, taskLink, taskSources, useTaskSessionRevision, type TaskSource } from "./session";
import { TaskNotificationPermission } from "./notifications";
import { elapsedLabel, stageLabel, taskResultLinks, taskStatusLabels } from "./presentation";

export default function TasksPage() {
    const revision = useTaskSessionRevision();
    const sources = taskSources();
    const [params, setParams] = useSearchParams();
    // An explicitly selected missing channel must not silently become another account's channel.
    const source = params.has("source") ? sources.find(item => item.id === params.get("source")) : sources[0];
    return <main className="mx-auto w-full max-w-6xl space-y-5 p-4 md:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-2xl font-semibold">任务中心</h1><Link to="/image">返回通用生图</Link></div>
        <p className="text-sm text-stone-500">查看当前账号渠道下的 GPT / Fal 服务端任务。阶段和耗时来自服务端，查询失败不会重新生成。共用渠道密钥的成员可看到同一任务列表。</p>
        <div className="flex flex-wrap items-center gap-3">
            <Select aria-label="任务渠道和模型" className="min-w-64" placeholder="选择任务渠道" value={source?.id} options={sources.map(item => ({ value: item.id, label: item.label }))} onChange={value => setParams({ source: value })} />
            <TaskNotificationPermission />
        </div>
        {source ? <TaskBoardMount key={`${revision}:${source.id}:${params.get("job") || ""}`} source={source} jobId={params.get("job") || undefined} /> : <Empty description="当前账号没有可用的任务渠道，请登录或配置 GPT Image / Fal 渠道后选择。" />}
    </main>;
}

function TaskBoardMount({ source, jobId }: { source: TaskSource; jobId?: string }) {
    const [board, setBoard] = useState<TaskBoard | null>(null);
    const [error, setError] = useState("");
    useEffect(() => {
        try {
            const next = new TaskBoard(taskClient(source), jobId);
            setBoard(next);
            void next.load();
            const timer = setInterval(() => void next.load(), 5000);
            return () => { clearInterval(timer); next.dispose(); };
        } catch (error) { setError(error instanceof Error ? error.message : "渠道不可用"); }
    }, [source.id, source.session.revision, jobId]);
    if (error) return <Alert type="error" title={error} />;
    return board ? <TaskBoardView board={board} source={source} /> : <p role="status">正在加载任务…</p>;
}

function TaskBoardView({ board, source }: { board: TaskBoard; source: TaskSource }) {
    const state = useSyncExternalStore(board.subscribe, board.getSnapshot);
    return <section className="space-y-4" aria-busy={state.busy}>
        <div className="flex flex-wrap items-center gap-2">
            <Button loading={state.busy} onClick={() => void board.load()}>刷新当前页</Button>
            <Button disabled={state.busy} onClick={() => void board.first()}>最新任务</Button>
            <Button disabled={state.busy || !state.history.length} onClick={() => void board.back()}>上一页</Button>
            <span>第 {state.history.length + 1} 页</span>
            <Button disabled={state.busy || !state.page.nextCursor} onClick={() => void board.next()}>下一页</Button>
        </div>
        {state.error ? <Alert type="warning" showIcon title="查询或操作未完成" description={`${state.error}。已显示的数据可能过时，可刷新查询原任务。`} /> : null}
        {board.jobId ? <div className="space-y-2"><Link to={taskLink(source.id)}>返回该渠道列表</Link><h2 className="text-lg font-semibold">任务详情</h2>{state.detail ? <TaskCard task={state.detail} detail board={board} source={source} disabled={state.busy || !!state.error} /> : !state.busy && !state.error ? <p>没有任务详情</p> : null}</div> : null}
        <div className="space-y-3">{state.page.items.map(task => <TaskCard key={task.jobId} task={task} board={board} source={source} disabled={state.busy || !!state.error} />)}</div>
        {!state.page.items.length && !state.busy && !state.error ? <Empty description="此页没有任务" /> : null}
        <p className="text-xs text-stone-500">任务结果可能在保留期限后过期，请及时下载。取消请求需服务端确认；关闭页面不会取消服务端任务。</p>
    </section>;
}

function TaskCard({ task, source, board, detail = false, disabled }: { task: Task; source: TaskSource; board: TaskBoard; detail?: boolean; disabled: boolean }) {
    const canResume = task.status === "recoverable" && task.actions.retry.allowed && task.actions.retry.mode === "resume_query";
    const canCancel = task.status !== "uncertain" && task.actions.cancel.allowed;
    const results = detail ? taskResultLinks(task) : [];
    return <article className="space-y-3 rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-700 dark:bg-stone-900" data-task-id={task.jobId}>
        <div className="flex flex-wrap items-center justify-between gap-2"><div className="min-w-0"><span className="font-medium">{task.model || source.label}</span><p className="break-all text-xs text-stone-500">{task.jobId}</p></div><Tag color={task.status === "succeeded" ? "green" : task.status === "failed" ? "red" : task.status === "uncertain" ? "orange" : undefined}>{taskStatusLabels[task.status]}</Tag></div>
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm"><span>阶段：{stageLabel(task.progress.stage)}</span><span>耗时：{elapsedLabel(task.elapsedMs)}</span><span>创建：{task.createdAt === null ? "未知" : new Date(task.createdAt).toLocaleString()}</span></div>
        <p className="text-xs text-stone-500">{task.queueMode === "encrypted_persistent" ? "服务端持久队列" : task.queueMode === "admission_only" ? "服务端即时受理（未启用持久等待）" : "队列模式未知"}{task.expiresAt ? ` · 保留至 ${new Date(task.expiresAt).toLocaleString()}` : ""}</p>
        {task.error ? <p role="status" className="text-red-600 dark:text-red-400">{task.error.message}</p> : null}
        {task.status === "uncertain" ? <p className="text-amber-700 dark:text-amber-400">上游是否完成尚不确定，不能安全重试。请核对原任务，避免重复扣费。</p> : null}
        {task.status === "recoverable" ? <p className="text-sm">可继续查询已有上游任务，恢复操作不会提交新的生成。</p> : null}
        <div className="flex flex-wrap items-center gap-2">
            <Link to={taskLink(source.id, task.resultJobId || task.jobId)}>{task.status === "succeeded" ? "查看结果" : "查看详情"}</Link>
            <Button disabled={disabled || !canCancel} title={canCancel ? "请求取消原任务" : "服务端当前不允许取消"} onClick={() => void board.action(task, "cancel")}>请求取消</Button>
            <Button disabled={disabled || !canResume} title={canResume ? "只恢复原任务查询" : "当前状态不允许恢复查询"} onClick={() => void board.action(task, "resume")}>恢复查询</Button>
        </div>
        {detail && task.resultExpired ? <Alert type="warning" title="结果已过期，无法从任务服务恢复" /> : null}
        {detail && task.status === "succeeded" && !task.resultExpired ? <div className="flex flex-wrap gap-3">{results.length ? results.map((url, index) => <a key={index} href={url} download={url.startsWith("data:") ? `task-${task.jobId}-${index + 1}.png` : undefined} target={url.startsWith("data:") ? undefined : "_blank"} rel="noopener noreferrer">打开 / 下载结果 {index + 1}</a>) : <p>此任务未返回可显示的图片地址。</p>}</div> : null}
    </article>;
}
