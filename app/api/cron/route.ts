// app/api/cron/route.ts
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const authHeader = request.headers.get("Authorization");
  const cronSecret = process.env.CRON_SECRET;
  const isProduction = process.env.NODE_ENV === "production";
  
  // Production mein sirf secret check karo
  if (isProduction && cronSecret && (!authHeader || authHeader !== `Bearer ${cronSecret}`)) {
    console.log("Cron: Unauthorized attempt");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    console.log("Cron job executed:", new Date().toISOString());
    
    // Yahan apna task likho
    // Example:
    // await cleanupOldData();
    // await sendScheduledEmails();
    
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