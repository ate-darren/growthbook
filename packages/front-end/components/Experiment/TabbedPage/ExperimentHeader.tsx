import { ExperimentInterfaceStringDates } from "back-end/types/experiment";
import Link from "next/link";
import { FaChartBar, FaCog } from "react-icons/fa";
import { useRouter } from "next/router";
import { getAffectedEnvsForExperiment } from "shared/util";
import { useAuth } from "@/services/auth";
import { GBCircleArrowLeft } from "@/components/Icons";
import WatchButton from "@/components/WatchButton";
import MoreMenu from "@/components/Dropdown/MoreMenu";
import ConfirmButton from "@/components/Modal/ConfirmButton";
import DeleteButton from "@/components/DeleteButton/DeleteButton";
import TabButtons from "@/components/Tabs/TabButtons";
import TabButton from "@/components/Tabs/TabButton";
import usePermissions from "@/hooks/usePermissions";
import HeaderWithEdit from "@/components/Layout/HeaderWithEdit";
import StatusIndicator from "../StatusIndicator";
import ResultsIndicator from "../ResultsIndicator";
import { ExperimentTab, getDates } from ".";

export interface Props {
  tab: ExperimentTab;
  setTab: (tab: ExperimentTab) => void;
  experiment: ExperimentInterfaceStringDates;
  mutate: () => void;
  duplicate?: (() => void) | null;
  setEditNameOpen: (open: boolean) => void;
  setStatusModal: (open: boolean) => void;
  setAuditModal: (open: boolean) => void;
  setWatchersModal: (open: boolean) => void;
  safeToEdit: boolean;
  usersWatching: (string | undefined)[];
}

export default function ExperimentHeader({
  tab,
  setTab,
  experiment,
  mutate,
  setEditNameOpen,
  duplicate,
  setAuditModal,
  setStatusModal,
  setWatchersModal,
  safeToEdit,
  usersWatching,
}: Props) {
  const { apiCall } = useAuth();
  const router = useRouter();
  const permissions = usePermissions();

  const canCreateAnalyses = permissions.check(
    "createAnalyses",
    experiment.project
  );
  const canEditExperiment = !experiment.archived && canCreateAnalyses;

  let hasRunExperimentsPermission = true;
  const envs = getAffectedEnvsForExperiment({ experiment });
  if (envs.length > 0) {
    if (!permissions.check("runExperiments", experiment.project, envs)) {
      hasRunExperimentsPermission = false;
    }
  }
  const canRunExperiment = canEditExperiment && hasRunExperimentsPermission;

  const { startDate, endDate } = getDates(experiment);

  return (
    <div
      className="bg-white px-3 pt-3 border-bottom"
      style={{ marginLeft: -8, marginRight: -8, marginTop: -3 }}
    >
      <div className="container-fluid pagecontents">
        <div className="row align-items-top">
          <div className="col-auto">
            <div style={{ marginTop: -8, marginBottom: 8 }}>
              <Link
                href={`/experiments${
                  experiment.status === "draft"
                    ? "#drafts"
                    : experiment.status === "stopped"
                    ? "#stopped"
                    : ""
                }`}
              >
                <a>
                  <GBCircleArrowLeft /> Back to all experiments
                </a>
              </Link>
            </div>

            <HeaderWithEdit
              className="h1 mb-0"
              edit={canRunExperiment ? () => setEditNameOpen(true) : undefined}
              editClassName="ml-1"
            >
              {experiment.name}
            </HeaderWithEdit>
          </div>

          <div className="flex-1 col"></div>

          <div className="col-auto">
            <WatchButton itemType="experiment" item={experiment.id} />
          </div>

          <div className="col-auto">
            <MoreMenu>
              {canRunExperiment && (
                <button
                  className="dropdown-item"
                  onClick={() => setStatusModal(true)}
                >
                  Edit status
                </button>
              )}
              <button
                className="dropdown-item"
                onClick={() => setAuditModal(true)}
              >
                Audit log
              </button>
              <button
                className="dropdown-item"
                onClick={() => setWatchersModal(true)}
              >
                View watchers{" "}
                <span className="badge badge-pill badge-info">
                  {usersWatching.length}
                </span>
              </button>
              {duplicate && (
                <button className="dropdown-item" onClick={duplicate}>
                  Duplicate
                </button>
              )}
              {canRunExperiment && (
                <ConfirmButton
                  modalHeader="Archive Experiment"
                  confirmationText={
                    <div>
                      <p>Are you sure you want to archive this experiment?</p>
                      {!safeToEdit ? (
                        <div className="alert alert-danger">
                          This will immediately stop all linked Feature Flags
                          and Visual Changes from running
                        </div>
                      ) : null}
                    </div>
                  }
                  onClick={async () => {
                    try {
                      await apiCall(`/experiment/${experiment.id}/archive`, {
                        method: "POST",
                      });
                      mutate();
                    } catch (e) {
                      console.error(e);
                    }
                  }}
                  cta="Archive"
                >
                  <button className="dropdown-item" type="button">
                    Archive
                  </button>
                </ConfirmButton>
              )}
              {canCreateAnalyses && experiment.archived && (
                <button
                  className="dropdown-item"
                  onClick={async (e) => {
                    e.preventDefault();
                    try {
                      await apiCall(`/experiment/${experiment.id}/unarchive`, {
                        method: "POST",
                      });
                      mutate();
                    } catch (e) {
                      console.error(e);
                    }
                  }}
                >
                  Unarchive
                </button>
              )}
              {canCreateAnalyses && (
                <DeleteButton
                  className="dropdown-item text-danger"
                  useIcon={false}
                  text="Delete"
                  displayName="Experiment"
                  additionalMessage={
                    !safeToEdit ? (
                      <div className="alert alert-danger">
                        Deleting this experiment will also affect all linked
                        Feature Flags and Visual Changes
                      </div>
                    ) : null
                  }
                  onClick={async () => {
                    await apiCall<{ status: number; message?: string }>(
                      `/experiment/${experiment.id}`,
                      {
                        method: "DELETE",
                        body: JSON.stringify({ id: experiment.id }),
                      }
                    );
                    router.push("/experiments");
                  }}
                />
              )}
            </MoreMenu>
          </div>
        </div>
        <div className="row align-items-center">
          <div className="col-auto pt-2" id="experiment-page-tabs">
            <TabButtons className="mb-0 pb-0">
              <TabButton
                active={tab === "setup"}
                display={
                  <>
                    <FaCog /> Setup
                  </>
                }
                onClick={() => setTab("setup")}
                newStyle={false}
                activeClassName="active-tab"
              />
              <TabButton
                active={tab === "results"}
                display={
                  <>
                    <FaChartBar /> Results
                  </>
                }
                onClick={() => setTab("results")}
                newStyle={false}
                activeClassName="active-tab"
                last={false}
              />
            </TabButtons>
          </div>
          <div className="col-auto ml-auto"></div>
          <div className="col-auto experiment-dates text-center">
            <div className="mt-1 small text-gray">
              {startDate && (
                <>
                  {startDate}
                  {endDate && <> — {endDate}</>}
                </>
              )}
            </div>
          </div>

          <div className="col-auto">
            <div className="experiment-status-widget border d-flex">
              <div
                className="d-flex px-3"
                style={{ height: 30, lineHeight: "30px" }}
              >
                <StatusIndicator
                  archived={experiment.archived}
                  status={experiment.status}
                />
              </div>
              {experiment.status === "stopped" && experiment.results && (
                <div
                  className="d-flex border-left"
                  style={{ height: 30, lineHeight: "30px" }}
                >
                  <ResultsIndicator results={experiment.results} />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
