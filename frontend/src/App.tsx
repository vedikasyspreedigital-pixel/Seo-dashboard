import { Navigate, Route, Routes } from 'react-router-dom';
import { OverviewPage } from './pages/OverviewPage';
import { RunsListPage } from './pages/RunsListPage';
import { NewRunPage } from './pages/NewRunPage';
import { RunDetailPage } from './pages/RunDetailPage';
import { ReportsListPage } from './pages/ReportsListPage';
import { GenerateReportPage } from './pages/report-wizard/GenerateReportPage';
import { AnalyticsPreviewPage } from './pages/report-wizard/AnalyticsPreviewPage';
import { AnalystInsightsPage } from './pages/report-wizard/AnalystInsightsPage';
import { ReportPreviewWizardPage } from './pages/report-wizard/ReportPreviewWizardPage';
import { EmailDraftPage } from './pages/report-wizard/EmailDraftPage';
import { SendConfirmationPage } from './pages/report-wizard/SendConfirmationPage';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/overview" replace />} />
      <Route path="/overview" element={<OverviewPage />} />
      <Route path="/runs" element={<RunsListPage />} />
      <Route path="/runs/new" element={<NewRunPage />} />
      <Route path="/runs/:runId" element={<RunDetailPage />} />
      <Route path="/runs/:runId/report/new" element={<GenerateReportPage />} />
      <Route path="/reports" element={<ReportsListPage />} />
      <Route path="/reports/:reportId/analytics" element={<AnalyticsPreviewPage />} />
      <Route path="/reports/:reportId/insights" element={<AnalystInsightsPage />} />
      <Route path="/reports/:reportId/preview" element={<ReportPreviewWizardPage />} />
      <Route path="/reports/:reportId/email" element={<EmailDraftPage />} />
      <Route path="/reports/:reportId/send" element={<SendConfirmationPage />} />
    </Routes>
  );
}
