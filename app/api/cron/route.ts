// app/api/cron/route.ts
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  // Security: Secret check karo
  const authHeader = request.headers.get("Authorization");
  const cronSecret = process.env.CRON_SECRET;
  
  // Agar secret set hai aur request mein sahi secret nahi hai, toh reject karo
  if (cronSecret && (!authHeader || authHeader !== `Bearer ${cronSecret}`)) {
    console.log("Cron: Unauthorized attempt");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Yahan apna kaam karo jo cron ke waqt hona chahiye
    console.log("Cron job started:", new Date().toISOString());
    
    // Example tasks (jo chahiye unhe uncomment karo):
    
    // 1. Database cleanup
    // await cleanupOldData();
    
    // 2. Send scheduled emails
    // await sendScheduledEmails();
    
    // 3. Sync data
    // await syncData();
    
    // 4. Update analytics
    // await updateAnalytics();
    
    // Temporary: sirf log print karo
    await new Promise(resolve => setTimeout(resolve, 100));
    
    console.log("Cron job completed:", new Date().toISOString());
    
    return NextResponse.json({ 
      success: true, 
      message: "Cron job executed successfully",
      timestamp: new Date().toISOString() 
    });
  } catch (error) {
    console.error("Cron job failed:", error);
    return NextResponse.json({ 
      success: false, 
      error: error instanceof Error ? error.message : "Error occurred" 
    }, { status: 500 });
  }
}